const express = require('express');
const { Telegraf, Markup, Scenes, session } = require('telegraf');
const admin = require('firebase-admin');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const winston = require('winston');
const Bottleneck = require('bottleneck');
const bodyParser = require('body-parser');
require('dotenv').config();

// =============== Logger Setup ===================
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'bot.log', maxsize: 5242880, maxFiles: 5 }) // 5MB per file, keep last 5 files
  ],
});

// =================== Firebase Setup ===================
const serviceAccount = require('./directpay.json'); // Ensure this file is secured on the server
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://directpay9ja.firebaseio.com"
});
const db = admin.firestore();

// ========== Keys ===================
const BOT_TOKEN = process.env.BOT_TOKEN;
const PAYCREST_API_KEY = process.env.PAYCREST_API_KEY; // Client ID
const PAYCREST_CLIENT_SECRET = process.env.PAYCREST_CLIENT_SECRET; // Client Secret
const PAYCREST_RATE_API_URL = process.env.PAYCREST_RATE_API_URL || 'https://api.paycrest.io/v1/rates'; // Paycrest Rate API Endpoint
const PAYCREST_RETURN_ADDRESS = process.env.PAYCREST_RETURN_ADDRESS || "0xYourReturnAddressHere"; // Paycrest Return Address
const PERSONAL_CHAT_ID = process.env.PERSONAL_CHAT_ID;
const PAYSTACK_API_KEY = process.env.PAYSTACK_API_KEY;
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => id.trim()) : [];
const MAX_WALLETS = 5;

// Telegram Webhook 
const TELEGRAM_WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/webhook/telegram'; // e.g., '/webhook/telegram'
const WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN; // e.g., 'https://your-domain.com'
const TELEGRAM_WEBHOOK_URL = `${WEBHOOK_DOMAIN}${TELEGRAM_WEBHOOK_PATH}`;

// Blockradar API Keys Mapping
const BLOCKRADAR_API_KEYS = {
  'Base': process.env.BLOCKRADAR_BASE_API_KEY,
  'BNB Smart Chain': process.env.BLOCKRADAR_BNB_API_KEY,
  'Polygon': process.env.BLOCKRADAR_POLYGON_API_KEY,
};

//  Assets
const SUPPORTED_ASSETS = ['USDC', 'USDT'];

// Exchange Rates 
let exchangeRates = {
  USDC: 0,
  USDT: 0
};

// ========== Exchange Rate from paycrest ==========
async function fetchExchangeRate(asset) {
  try {
    const response = await axios.get(`${PAYCREST_RATE_API_URL}`, {
      headers: {
        'Authorization': `Bearer ${PAYCREST_API_KEY}`,
        'Content-Type': 'application/json'
      },
    });

    if (response.data.status === 'success' && response.data.data) {
      const rate = parseFloat(response.data.data);
      if (isNaN(rate)) {
        throw new Error(`Invalid rate data for ${asset}: ${response.data.data}`);
      }
      return rate;
    } else {
      throw new Error(`Failed to fetch rate for ${asset}: ${response.data.message || 'Unknown error'}`);
    }
  } catch (error) {
    logger.error(`Error fetching exchange rate for ${asset} from Paycrest: ${error.message}`);
    throw error;
  }
}

async function fetchExchangeRates() {
  try {
    const rates = {};
    for (const asset of SUPPORTED_ASSETS) {
      rates[asset] = await fetchExchangeRate(asset);
    }
    exchangeRates = rates;
    logger.info('Exchange rates updated successfully from Paycrest.');
  } catch (error) {
    logger.error(`Error fetching exchange rates from Paycrest: ${error.message}`);
    // Optionally, retain previous rates or handle as needed
  }
}

// Initial fetch
fetchExchangeRates();

// Update Exchange Rates Every 5 Minutes
setInterval(fetchExchangeRates, 300000); // 5 minutes

// =================== Multi-Chain Wallet Configuration ===================
const chains = {
  Base: {
    id: 'e31c44d6-0344-4ee1-bcd1-c88e89a9e3f1',
    key: BLOCKRADAR_API_KEYS['Base'],
    address: '0xfBeEC99b731B97271FF31E518c84d4a0E24B1118',
    apiUrl: 'https://api.blockradar.co/v1/wallets/e31c44d6-0344-4ee1-bcd1-c88e89a9e3f1/addresses',
    supportedAssets: ['USDC', 'USDT'],
    network: 'Base',
    assets: {
      USDC: 'a8aae94e-a2c3-424c-8db5-ea7415166ce3',
      USDT: 'a8aae94e-a2c3-424c-8db5-ea7415166ce3',
    }
  },
  Polygon: {
    id: 'f4fc4dc4-a0d5-4303-a60b-e58ec1fc6d0a',
    key: BLOCKRADAR_API_KEYS['Polygon'],
    address: '0xfBeEC99b731B97271FF31E518c84d4a0E24B1118',
    apiUrl: 'https://api.blockradar.co/v1/wallets/f4fc4dc4-a0d5-4303-a60b-e58ec1fc6d0a/addresses',
    supportedAssets: ['USDC', 'USDT'],
    network: 'Polygon',
    assets: {
      USDC: 'f348e8e3-e0b4-4704-857e-c274ef000c00',
      USDT: 'c9d57a33-375b-46f7-b694-16e9b498e0e1',
    }
  },
  'BNB Smart Chain': {
    id: '7a844e91-5740-4589-9695-c74411adec7e',
    key: BLOCKRADAR_API_KEYS['BNB Smart Chain'],
    address: '0x9A52605A21e3bacD791579D980A975b258968041',
    apiUrl: 'https://api.blockradar.co/v1/wallets/7a844e91-5740-4589-9695-c74411adec7e/addresses',
    supportedAssets: ['USDT', 'USDC'],
    network: 'BNB Smart Chain',
    assets: {
      USDC: 'ff479231-0dbb-4760-b695-e219a50934af',
      USDT: '03a11a51-1422-4ac0-abc0-b2fed75e9fcb',
    }
  }
};

// Chain Mapping to handle variation in chain names
const chainMapping = {
  'base': 'Base',
  'polygon': 'Polygon',
  'bnb smart chain': 'BNB Smart Chain',
  'bnb smartchain': 'BNB Smart Chain',
  'bnb chain': 'BNB Smart Chain',
  'bnb': 'BNB Smart Chain',
  // Add more mappings if necessary
};

// =================== Initialize Express App ===================
const app = express();

// Use JSON middleware for all routes except Paycrest webhook
app.use((req, res, next) => {
  if (req.path === '/webhook/paycrest') {
    next();
  } else {
    express.json()(req, res, next);
  }
});

// =================== Initialize Bot ===================
const bot = new Telegraf(BOT_TOKEN);

// =================== Start the Bot and Express Server ===================

// Set Telegram webhook
(async () => {
  try {
    await bot.telegram.setWebhook(TELEGRAM_WEBHOOK_URL);
    logger.info(`Telegram webhook set to ${TELEGRAM_WEBHOOK_URL}`);
  } catch (error) {
    logger.error(`Failed to set Telegram webhook: ${error.message}`);
    process.exit(1);
  }
})();

// Telegram Webhook Handler
app.post(TELEGRAM_WEBHOOK_PATH, (req, res) => {
  bot.handleUpdate(req.body, res);
});

// Start Express Server
const port = process.env.PORT || 4000;
app.listen(port, () => {
  logger.info(`Webhook server running on port ${port}`);
});

// =================== Scenes and Middleware Setup ===================
const stage = new Scenes.Stage();
stage.register(bankLinkingScene, sendMessageScene, receiptGenerationScene);
bot.use(session());
bot.use(stage.middleware());

// =================== Bank List ===================
const bankList = [
  { name: 'Access Bank', code: '044', aliases: ['access', 'access bank', 'accessb', 'access bank nigeria'], paycrestInstitutionCode: 'ABNGNGLA' },
  // ... (rest of the banks)
  { name: 'Wema Bank', code: '035', aliases: ['wema', 'wema bank', 'wemab', 'wema bank nigeria'], paycrestInstitutionCode: 'WEMANGLA' },
  { name: 'Kuda Microfinance Bank', code: '50211', aliases: ['kuda', 'kuda bank', 'kudab', 'kuda bank nigeria'], paycrestInstitutionCode: 'KUDANGPC' },
  { name: 'OPay', code: '999992', aliases: ['opay', 'opay nigeria'], paycrestInstitutionCode: 'OPAYNGPC' },
  { name: 'PalmPay', code: '999991', aliases: ['palmpay', 'palmpay nigeria'], paycrestInstitutionCode: 'PALMNGPC' },
  { name: 'Paystack-Titan MFB', code: '999992', aliases: ['paystack', 'paystack mfb', 'paystack-titan mfb'], paycrestInstitutionCode: 'PAYTNGPC' },
  { name: 'Moniepoint MFB', code: '999993', aliases: ['moniepoint', 'moniepoint mfb', 'moniepoint nigeria'], paycrestInstitutionCode: 'MONINGPC' },
  { name: 'Safe Haven MFB', code: '999994', aliases: ['safe haven', 'safe haven mfb', 'safe haven nigeria'], paycrestInstitutionCode: 'SAHVNGPC' },
  // Add more banks as needed
];

// =================== Helper Functions ===================

function mapToPaycrest(asset, chainName) {
  // Only USDC and USDT are supported
  if (!SUPPORTED_ASSETS.includes(asset)) return null;

  let token = asset.toUpperCase(); // 'USDC' or 'USDT'
  let network;
  const chainKey = chainMapping[chainName.toLowerCase()];
  if (!chainKey) {
    logger.error(`No mapping found for chain name: ${chainName}`);
    return null;
  }
  if (/polygon/i.test(chainKey)) network = 'polygon';
  else if (/base/i.test(chainKey)) network = 'base';
  else if (/bnb-smart-chain/i.test(chainKey)) network = 'bnb-smart-chain';
  else return null;
  return { token, network };
}

function calculatePayout(asset, amount) {
  const rate = exchangeRates[asset];
  if (!rate) {
    throw new Error(`Unsupported asset received: ${asset}`);
  }
  return parseFloat((amount * rate).toFixed(2)); // Changed to return a number
}

function generateReferenceId() {
  return 'REF-' + Math.random().toString(36).substr(2, 9).toUpperCase();
}

async function verifyBankAccount(accountNumber, bankCode) {
  try {
    const response = await axios.get(`https://api.paystack.co/bank/resolve`, {
      params: { account_number: accountNumber, bank_code: bankCode },
      headers: { Authorization: `Bearer ${PAYSTACK_API_KEY}` },
    });
    return response.data;
  } catch (error) {
    logger.error(`Error verifying bank account (${accountNumber}, ${bankCode}): ${error.response ? error.response.data.message : error.message}`);
    throw new Error('Failed to verify bank account. Please try again later.');
  }
}

async function createPaycrestOrder(userId, amount, token, network, recipientDetails, userSendAddress) {
  try {
    // Map to Paycrest network and token
    const paycrestMapping = mapToPaycrest(token, network);
    if (!paycrestMapping) {
      throw new Error('No Paycrest mapping for the selected asset/chain.');
    }

    // Fetch the Paycrest Institution Code
    const bank = bankList.find(b => b.name.toLowerCase() === recipientDetails.bankName.toLowerCase());
    if (!bank || !bank.paycrestInstitutionCode) {
      const errorMsg = `No Paycrest institution code found for bank: ${recipientDetails.bankName}`;
      logger.error(errorMsg);
      // Notify admin about the missing institution code
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ ${errorMsg} for user ${userId}.`);
      throw new Error(errorMsg);
    }

    const recipient = {
      institution: bank.paycrestInstitutionCode, // Use the mapped Paycrest institution code
      accountIdentifier: recipientDetails.accountNumber,
      accountName: recipientDetails.accountName,
      memo: `Payment from DirectPay`,
      providerId: "" // Assuming empty; update if necessary
    };

    // Fetch the current rate from exchangeRates
    const rate = exchangeRates[token];
    if (!rate) {
      throw new Error(`Exchange rate for ${token} not available.`);
    }

    // payload
    const orderPayload = {
      amount: String(amount), // Token amount as string
      rate: String(rate), // Exchange rate as string from Paycrest Rate API
      network: paycrestMapping.network, // e.g., 'polygon', 'base', etc.
      token: paycrestMapping.token, // 'USDT' or 'USDC'
      recipient: recipient,
      returnAddress: userSendAddress || PAYCREST_RETURN_ADDRESS, // Use user's send address or default
      feePercent: 2, // Example fee percentage
    };

    // API req
    const orderResp = await axios.post('https://api.paycrest.io/v1/sender/orders', orderPayload, {
      headers: {
        'API-Key': PAYCREST_API_KEY,
        'Content-Type': 'application/json'
      }
    });

    // response OK?
    if (orderResp.data.status !== 'success') {
      throw new Error(`Paycrest order creation failed: ${orderResp.data.message}`);
    }

    // Return the order data
    return orderResp.data.data; // Contains id, amount, token, network, receiveAddress, etc.
  } catch (err) {
    logger.error(`Error creating Paycrest order: ${err.response ? err.response.data.message : err.message}`);
    throw new Error('Failed to create Paycrest order.');
  }
}

// withdraw from blockradar
async function withdrawFromBlockradar(chain, assetId, address, amount, reference, metadata) {
  try {
    // Ensure the chain exists in the mapping
    const chainKey = chainMapping[chain.toLowerCase()];
    if (!chainKey) {
      throw new Error(`Unsupported or unknown chain: ${chain}`);
    }

    const chainData = chains[chainKey];
    if (!chainData) {
      throw new Error(`Chain data not found for: ${chainKey}`);
    }

    const resp = await axios.post(`https://api.blockradar.co/v1/wallets/${chainData.id}/withdraw`, {
      address,
      amount: String(amount),
      assetId,
      reference,
      metadata
    }, {
      headers: {
        'x-api-key': chainData.key, // Use the mapped API key
        'Content-Type': 'application/json'
      }
    });
    const data = resp.data;
    if (data.statusCode !== 200) {
      throw new Error(`Blockradar withdrawal error: ${JSON.stringify(data)}`);
    }
    return data;
  } catch (error) {
    logger.error(`Error withdrawing from Blockradar: ${error.response ? error.response.data.message : error.message}`);
    throw error;
  }
}

async function getUserState(userId) {
  try {
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      // Initialize user state if not exists with all necessary properties
      await db.collection('users').doc(userId).set({
        firstName: '', // Will be updated upon first interaction
        wallets: [],
        walletAddresses: [],
        hasReceivedDeposit: false,
        awaitingBroadcastMessage: false, // For admin broadcast
      });
      return {
        firstName: '',
        wallets: [],
        walletAddresses: [],
        hasReceivedDeposit: false,
        awaitingBroadcastMessage: false,
      };
    } else {
      const data = userDoc.data();
      // Ensure all properties are defined, else set default values
      return {
        firstName: data.firstName || '',
        wallets: data.wallets || [],
        walletAddresses: data.walletAddresses || [],
        hasReceivedDeposit: data.hasReceivedDeposit || false,
        awaitingBroadcastMessage: data.awaitingBroadcastMessage || false,
      };
    }
  } catch (error) {
    logger.error(`Error getting user state for ${userId}: ${error.message}`);
    throw error;
  }
}

async function updateUserState(userId, newState) {
  try {
    await db.collection('users').doc(userId).update(newState);
  } catch (error) {
    logger.error(`Error updating user state for ${userId}: ${error.message}`);
    throw error;
  }
}

async function generateWallet(chain) {
  try {
    const chainData = chains[chain];
    if (!chainData) {
      throw new Error(`Unsupported chain: ${chain}`);
    }

    const response = await axios.post(
      chainData.apiUrl,
      { name: `DirectPay_User_Wallet_${chain}` },
      { headers: { 'x-api-key': chainData.key } }
    );

    const walletAddress = response.data.data.address;
    if (!walletAddress) {
      throw new Error('Wallet address not returned from Blockradar.');
    }
    return walletAddress;
  } catch (error) {
    logger.error(`Error generating wallet for ${chain}: ${error.response ? error.response.data.message : error.message}`);
    throw new Error(`Error generating wallet for ${chain}: ${error.response ? error.response.data.message : error.message}`);
  }
}

function generateReceipt(txData) {
  let receiptMessage = `🧾 *Transaction Receipt*\n\n`;
  receiptMessage += `*Reference ID:* \`${txData.referenceId || 'N/A'}\`\n`;
  receiptMessage += `*Amount:* ${txData.amount || 'N/A'} ${txData.asset || 'N/A'}\n`;
  receiptMessage += `*Status:* ${txData.status || 'Pending'}\n`;
  receiptMessage += `*Exchange Rate:* ₦${exchangeRates[txData.asset] || 'N/A'} per ${txData.asset || 'N/A'}\n`;
  receiptMessage += `*Date:* ${txData.timestamp ? new Date(txData.timestamp).toLocaleString() : 'N/A'}\n`;
  receiptMessage += `*Chain:* ${txData.chain || 'N/A'}\n`;

  return receiptMessage;
}

// Bot Commands & Scenes 

// /start Command
bot.start(async (ctx) => {
  try {
    await greetUser(ctx);
  } catch (error) {
    logger.error(`Error in /start command: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
  }
});

// Greet User
async function greetUser(ctx) {
  const userId = ctx.from.id.toString();
  let userState;
  try {
    userState = await getUserState(userId);

    // If firstName is empty, update it from ctx.from.first_name
    if (!userState.firstName) {
      await db.collection('users').doc(userId).update({
        firstName: ctx.from.first_name || 'Valued User'
      });
      userState.firstName = ctx.from.first_name || 'Valued User';
    }
  } catch (error) {
    logger.error(`Error fetching user state for ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
    return;
  }

  const walletExists = userState.wallets.length > 0;
  const hasBankLinked = userState.wallets.some(wallet => wallet.bank);
  const adminUser = isAdmin(userId);

  const greeting = walletExists
    ? `👋 Hello, ${userState.firstName}!\n\nWelcome back to **DirectPay**, your gateway to seamless crypto transactions.\n\n💡 **Quick Start Guide:**\n1. **Add Your Bank Account**\n2. **Access Your Dedicated Wallet Address**\n3. **Send Stablecoins and Receive Cash Instantly**\n\nWe offer competitive rates and real-time updates to keep you informed. Your funds are secure, and you'll have cash in your account promptly!\n\nLet's get started!`
    : `👋 Welcome, ${userState.firstName}!\n\nThank you for choosing **DirectPay**. Let's embark on your crypto journey together. Use the menu below to get started.`;

  if (adminUser) {
    const sentMessage = await ctx.replyWithMarkdown(greeting, Markup.inlineKeyboard([
      [Markup.button.callback('🔧 Admin Panel', 'open_admin_panel')],
    ]));
    ctx.session.adminMessageId = sentMessage.message_id;
  } else {
    await ctx.replyWithMarkdown(greeting, getMainMenu(walletExists, hasBankLinked));
  }
}

// =================== Main Menu ===================

const getMainMenu = (walletExists, hasBankLinked) =>
  Markup.keyboard([
    [walletExists ? '💼 View Wallet' : '💼 Generate Wallet', hasBankLinked ? '⚙️ Settings' : '🏦 Link Bank Account'],
    ['💰 Transactions', 'ℹ️ Support', '📘 Learn About Base'],
    ['📈 View Current Rates'], // Added Refresh Rates Button
  ]).resize();

const getSettingsMenu = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Generate New Wallet', 'settings_generate_wallet')],
    [Markup.button.callback('✏️ Edit Linked Bank Details', 'settings_edit_bank')],
    [Markup.button.callback('💬 Support', 'settings_support')],
    [Markup.button.callback('🧾 Generate Transaction Receipt', 'settings_generate_receipt')],
    [Markup.button.callback('🔙 Back to Main Menu', 'settings_back_main')],
  ]);

// Check if admin 
const isAdmin = (userId) => ADMIN_IDS.includes(userId.toString());

// =================== Generate Wallet Handler ===================
bot.hears('💼 Generate Wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    
    if (userState.wallets.length >= MAX_WALLETS) {
      return ctx.replyWithMarkdown(`⚠️ You have reached the maximum number of wallets (${MAX_WALLETS}). Please manage your existing wallets before adding new ones.`);
    }
    
    // Added exchange rate information during wallet generation
    let ratesMessage = '📈 *Current Exchange Rates*:\n\n';
    for (const [asset, rate] of Object.entries(exchangeRates)) {
      ratesMessage += `• *${asset}*: ₦${rate}\n`;
    }
    ratesMessage += `\nThese rates will be applied during your deposits and payouts.`;

    await ctx.replyWithMarkdown(ratesMessage);

    await ctx.reply('📂 *Select the network for which you want to generate a wallet:*', Markup.inlineKeyboard([
      [Markup.button.callback('Base', 'generate_wallet_Base')],
      [Markup.button.callback('Polygon', 'generate_wallet_Polygon')],
      [Markup.button.callback('BNB Smart Chain', 'generate_wallet_BNB Smart Chain')],
    ]));
  } catch (error) {
    logger.error(`Error handling Generate Wallet for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while generating your wallet. Please try again later.');
  }
});

// Handle Wallet Generation for Inline Buttons
bot.action(/generate_wallet_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const selectedChainRaw = ctx.match[1]; // e.g., 'Base', 'Polygon', 'BNB Smart Chain'

  // Normalize and map the selected chain
  const selectedChainKey = chainMapping[selectedChainRaw.toLowerCase()];
  if (!selectedChainKey) {
    await ctx.replyWithMarkdown('⚠️ Invalid network selection. Please try again.');
    return ctx.answerCbQuery(); // Acknowledge the callback to remove loading state
  }

  const chain = selectedChainKey;

  // Acknowledge the Callback to Remove Loading State
  await ctx.answerCbQuery();

  // Inform User That Wallet Generation Has Started
  const generatingMessage = await ctx.replyWithMarkdown(`🔄 Generating Wallet for *${chain}*... Please wait a moment.`);

  try {
    const walletAddress = await generateWallet(chain);

    // Fetch Updated User State
    const userState = await getUserState(userId);

    if (userState.wallets.length >= MAX_WALLETS) {
      await ctx.replyWithMarkdown(`⚠️ You cannot generate more than ${MAX_WALLETS} wallets.`);
      await ctx.deleteMessage(generatingMessage.message_id);
      return;
    }

    // Add the New Wallet to User State
    userState.wallets.push({
      address: walletAddress || 'N/A',
      chain: chain || 'N/A',
      supportedAssets: chains[chain].supportedAssets ? [...chains[chain].supportedAssets] : [],
      bank: null,
      amount: 0 // Initialize amount if needed
    });

    // Also, Add the Wallet Address to walletAddresses Array
    const updatedWalletAddresses = userState.walletAddresses || [];
    updatedWalletAddresses.push(walletAddress);

    // Update User State in Firestore
    await updateUserState(userId, {
      wallets: userState.wallets,
      walletAddresses: updatedWalletAddresses,
    });

    // Log Wallet Generation
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `💼 Wallet generated for user ${userId} on ${chain}: ${walletAddress}`, { parse_mode: 'Markdown' });
    logger.info(`Wallet generated for user ${userId} on ${chain}: ${walletAddress}`);

    // Set walletIndex to the newly created wallet
    const newWalletIndex = userState.wallets.length - 1;
    ctx.session.walletIndex = newWalletIndex;

    // Delete the Generating Message
    await ctx.deleteMessage(generatingMessage.message_id);

    // Enter the Bank Linking Wizard Scene Immediately
    await ctx.scene.enter('bank_linking_scene');
  } catch (error) {
    logger.error(`Error generating wallet for user ${userId} on ${chain}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ There was an issue generating your wallet. Please try again later.');
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error generating wallet for user ${userId}: ${error.message}`, { parse_mode: 'Markdown' });
  }
});

// View Wallet Handler 

bot.hears('💼 View Wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    
    if (userState.wallets.length === 0) {
      return ctx.replyWithMarkdown('❌ You have no wallets. Please generate a wallet first using the "💼 Generate Wallet" option.');
    }

    // Implement Pagination
    const pageSize = 5; // Number of wallets per page
    const totalPages = Math.ceil(userState.wallets.length / pageSize);
    ctx.session.walletsPage = 1; // Initialize to first page

    const generateWalletPage = (page) => {
      const start = (page - 1) * pageSize;
      const end = start + pageSize;
      const wallets = userState.wallets.slice(start, end);

      let message = `💼 *Your Wallets* (Page ${page}/${totalPages}):\n\n`;
      wallets.forEach((wallet, index) => {
        const walletNumber = start + index + 1;
        message += `*Wallet ${walletNumber}:*\n`;
        message += `• *Chain:* ${wallet.chain}\n`;
        message += `• *Address:* \`${wallet.address}\`\n`;
        message += `• *Bank Linked:* ${wallet.bank ? '✅ Yes' : '❌ No'}\n\n`;
      });

      const navigationButtons = [];

      if (page > 1) {
        navigationButtons.push(Markup.button.callback('⬅️ Previous', `wallet_page_${page - 1}`));
      }
      if (page < totalPages) {
        navigationButtons.push(Markup.button.callback('Next ➡️', `wallet_page_${page + 1}`));
      }
      navigationButtons.push(Markup.button.callback('🔄 Refresh', `wallet_page_${page}`));

      const inlineKeyboard = Markup.inlineKeyboard([navigationButtons]);

      return { message, inlineKeyboard };
    };

    const { message, inlineKeyboard } = generateWalletPage(ctx.session.walletsPage);
    await ctx.replyWithMarkdown(message, inlineKeyboard);
  } catch (error) {
    logger.error(`Error handling View Wallet for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while fetching your wallets. Please try again later.');
  }
});

// Handle Wallet Page Navigation
bot.action(/wallet_page_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const requestedPage = parseInt(ctx.match[1], 10);

  try {
    const userState = await getUserState(userId);
    const pageSize = 5;
    const totalPages = Math.ceil(userState.wallets.length / pageSize);

    if (requestedPage < 1 || requestedPage > totalPages) {
      return ctx.answerCbQuery('⚠️ Invalid page number.', { show_alert: true });
    }

    ctx.session.walletsPage = requestedPage;

    const start = (requestedPage - 1) * pageSize;
    const end = start + pageSize;
    const wallets = userState.wallets.slice(start, end);

    let message = `💼 *Your Wallets* (Page ${requestedPage}/${totalPages}):\n\n`;
    wallets.forEach((wallet, index) => {
      const walletNumber = start + index + 1;
      message += `*Wallet ${walletNumber}:*\n`;
      message += `• *Chain:* ${wallet.chain}\n`;
      message += `• *Address:* \`${wallet.address}\`\n`;
      message += `• *Bank Linked:* ${wallet.bank ? '✅ Yes' : '❌ No'}\n\n`;
    });

    const navigationButtons = [];

    if (requestedPage > 1) {
      navigationButtons.push(Markup.button.callback('⬅️ Previous', `wallet_page_${requestedPage - 1}`));
    }
    if (requestedPage < totalPages) {
      navigationButtons.push(Markup.button.callback('Next ➡️', `wallet_page_${requestedPage + 1}`));
    }
    navigationButtons.push(Markup.button.callback('🔄 Refresh', `wallet_page_${requestedPage}`));

    const inlineKeyboard = Markup.inlineKeyboard([navigationButtons]);

    await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: inlineKeyboard.reply_markup });
    ctx.answerCbQuery(); // Acknowledge the callback
  } catch (error) {
    logger.error(`Error navigating wallet pages for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while navigating wallets. Please try again later.');
    ctx.answerCbQuery();
  }
});

// =================== Settings ===================
bot.hears('⚙️ Settings', async (ctx) => {
  await ctx.reply('⚙️ *Settings Menu*', getSettingsMenu());
});

// Handle "🔄 Generate New Wallet" in Settings
bot.action('settings_generate_wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    
    if (userState.wallets.length >= MAX_WALLETS) {
      return ctx.replyWithMarkdown(`⚠️ You have reached the maximum number of wallets (${MAX_WALLETS}). Please manage your existing wallets before adding new ones.`);
    }

    // Added exchange rate information during wallet generation
    let ratesMessage = '📈 *Current Exchange Rates*:\n\n';
    for (const [asset, rate] of Object.entries(exchangeRates)) {
      ratesMessage += `• *${asset}*: ₦${rate}\n`;
    }
    ratesMessage += `\nThese rates will be applied during your deposits and payouts.`;

    await ctx.replyWithMarkdown(ratesMessage);

    await ctx.reply('📂 *Select the network for which you want to generate a wallet:*', Markup.inlineKeyboard([
      [Markup.button.callback('Base', 'generate_wallet_Base')],
      [Markup.button.callback('Polygon', 'generate_wallet_Polygon')],
      [Markup.button.callback('BNB Smart Chain', 'generate_wallet_BNB Smart Chain')],
    ]));

    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error handling Generate New Wallet in Settings for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while generating your wallet. Please try again later.');
    ctx.answerCbQuery();
  }
});

//  Edit Linked Bank Details
bot.action('settings_edit_bank', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    
    if (userState.wallets.length === 0) {
      return ctx.replyWithMarkdown('❌ You have no wallets. Please generate a wallet first using the "💼 Generate Wallet" option.');
    }

    // If only one wallet, proceed to edit bank
    if (userState.wallets.length === 1) {
      ctx.session.walletIndex = 0;
      await ctx.scene.enter('bank_linking_scene');
    } else {
      // Multiple wallets, prompt user to select which wallet to edit
      let keyboard = userState.wallets.map((wallet, index) => [
        Markup.button.callback(`Wallet ${index + 1} - ${wallet.chain}`, `select_wallet_edit_bank_${index}`)
      ]);
      await ctx.reply('Please select the wallet for which you want to edit the bank details:', Markup.inlineKeyboard(keyboard));
    }
    
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error handling Edit Linked Bank Details in Settings for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while editing your bank details. Please try again later.');
    ctx.answerCbQuery();
  }
});

// Handle Wallet Selection for Editing Bank Details
bot.action(/select_wallet_edit_bank_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);

  if (isNaN(walletIndex)) {
    await ctx.replyWithMarkdown('⚠️ Invalid wallet selection. Please try again.');
    return ctx.answerCbQuery();
  }

  ctx.session.walletIndex = walletIndex;
  await ctx.scene.enter('bank_linking_scene');
  ctx.answerCbQuery();
});

// "💬 Support" in Settings
bot.action('settings_support', async (ctx) => {
  await ctx.replyWithMarkdown('🛠️ *Support Section*\n\nSelect an option below:', Markup.inlineKeyboard([
    [Markup.button.callback('❓ How It Works', 'support_how_it_works')],
    [Markup.button.callback('⚠️ Transaction Not Received', 'support_not_received')],
    [Markup.button.callback('💬 Contact Support', 'support_contact')],
  ]));
  ctx.answerCbQuery();
});

// Handle "🧾 Generate Transaction Receipt" in Settings
bot.action('settings_generate_receipt', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    
    if (userState.wallets.length === 0) {
      return ctx.replyWithMarkdown('❌ You have no wallets. Please generate a wallet first using the "💼 Generate Wallet" option.');
    }

    // Prompt user to select which wallet to generate receipt for
    let keyboard = userState.wallets.map((wallet, index) => [
      Markup.button.callback(`Wallet ${index + 1} - ${wallet.chain}`, `select_receipt_wallet_${index}`)
    ]);
    await ctx.reply('Please select the wallet for which you want to generate a transaction receipt:', Markup.inlineKeyboard(keyboard));
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error handling Generate Transaction Receipt in Settings for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while generating the receipt. Please try again later.');
    ctx.answerCbQuery();
  }
});

// Handle Wallet Selection for Generating Receipt
bot.action(/select_receipt_wallet_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);

  if (isNaN(walletIndex)) {
    await ctx.replyWithMarkdown('⚠️ Invalid wallet selection. Please try again.');
    return ctx.answerCbQuery();
  }

  ctx.session.walletIndex = walletIndex;
  await ctx.scene.enter('receipt_generation_scene');
  ctx.answerCbQuery();
});

// =================== Support ===================

const detailedTutorials = {
  how_it_works: `
**📘 How DirectPay Works**

1. **Generate Your Wallet:**
   - Navigate to the "💼 Generate Wallet" option.
   - Select your preferred network (Base, Polygon, BNB Smart Chain).
   - Receive a unique wallet address where you can receive crypto payments.

2. **Link Your Bank Account:**
   - After generating your wallet, provide your bank details to securely receive payouts directly into your bank account.

3. **Receive Payments:**
   - Share your wallet address with clients or payment sources.
   - Once a deposit is made, DirectPay will automatically convert the crypto to NGN at current exchange rates.

4. **Monitor Transactions:**
   - Use the "💰 Transactions" option to view all your deposit and payout activities.

5. **Support & Assistance:**
   - Access detailed support tutorials anytime from the "ℹ️ Support" section.

**🔒 Security:**
Your funds are secure with us. We utilize industry-standard encryption and security protocols to ensure your assets and information remain safe.

**💬 Need Help?**
Visit the support section or contact our support team at [@maxcswap](https://t.me/maxcswap) for any assistance.
`,
  transaction_guide: `
**💰 Transaction Not Received?**

If you haven't received your transaction, follow these steps to troubleshoot:

1. **Verify Wallet Address:**
   - Ensure that the sender used the correct wallet address provided by DirectPay.

2. **Check Bank Linking:**
   - Make sure your bank account is correctly linked.
   - If not linked, go to "⚙️ Settings" > "🏦 Link Bank Account" to add your bank details.

3. **Monitor Transaction Status:**
   - Use the "💰 Transactions" section to check the status of your deposit.
   - Pending status indicates that the deposit is being processed.

4. **Wait for Confirmation:**
   - Deposits might take a few minutes to reflect depending on the network congestion.

5. **Contact Support:**
   - If the issue persists after following the above steps, reach out to our support team at [@maxswap](https://t.me/maxcswap) with your transaction details for further assistance.
`,
  link_bank_tutorial: `
**🏦 How to Edit Your Bank Account**

*Editing an Existing Bank Account:*

1. **Navigate to Bank Editing:**
   - Click on "⚙️ Settings" > "✏️ Edit Linked Bank Details" from the main menu.

2. **Select the Wallet:**
   - Choose the wallet whose bank account you wish to edit.

3. **Provide New Bank Details:**
   - Enter the updated bank name or account number as required.

4. **Verify Changes:**
   - Confirm the updated account holder name.

5. **Completion:**
   - Your bank account details have been updated successfully.
`,
};

// =================== Learn About Base ===================
bot.hears(/📘\s*Learn About Base/i, async (ctx) => {
  await sendBaseContent(ctx, 0, true);
});

const baseContent = [
  {
    title: 'Welcome to Base',
    text: 'Base is a secure, low-cost, and developer-friendly Ethereum Layer 2 network. It offers a seamless way to onboard into the world of decentralized applications.',
  },
  {
    title: 'Why Choose Base?',
    text: '- **Lower Fees**: Significantly reduced transaction costs.\n- **Faster Transactions**: Swift confirmation times.\n- **Secure**: Built on Ethereum’s robust security.\n- **Developer-Friendly**: Compatible with EVM tools and infrastructure.',
  },
  {
    title: 'Getting Started',
    text: 'To start using Base, you can bridge your assets from Ethereum to Base using the official bridge at [Bridge Assets to Base](https://base.org/bridge).',
  },
  {
    title: 'Learn More',
    text: 'Visit the official documentation at [Base Documentation](https://docs.base.org) for in-depth guides and resources.',
  },
];

async function sendBaseContent(ctx, index, isNew = true) {
  const content = baseContent[index];
  const totalPages = baseContent.length;

  const navigationButtons = [];

  if (index > 0) {
    navigationButtons.push(Markup.button.callback('⬅️ Back', `base_page_${index - 1}`));
  }

  if (index < totalPages - 1) {
    navigationButtons.push(Markup.button.callback('Next ➡️', `base_page_${index + 1}`));
  }

  navigationButtons.push(Markup.button.callback('🔚 Exit', 'exit_base'));

  const inlineKeyboard = Markup.inlineKeyboard([navigationButtons]);

  if (isNew) {
    const sentMessage = await ctx.replyWithMarkdown(`**${content.title}**\n\n${content.text}`, inlineKeyboard);
    // Store the message ID in session
    ctx.session.baseMessageId = sentMessage.message_id;
  } else {
    try {
      await ctx.editMessageText(`**${content.title}**\n\n${content.text}`, {
        parse_mode: 'Markdown',
        reply_markup: inlineKeyboard.reply_markup,
      });
    } catch (error) {
      // If editing message fails, send a new message and update session
      const sentMessage = await ctx.replyWithMarkdown(`**${content.title}**\n\n${content.text}`, inlineKeyboard);
      ctx.session.baseMessageId = sentMessage.message_id;
    }
  }
}

// Base Content Pagination
bot.action(/base_page_(\d+)/, async (ctx) => {
  const index = parseInt(ctx.match[1], 10);
  if (isNaN(index) || index < 0 || index >= baseContent.length) {
    return ctx.answerCbQuery('⚠️ Invalid page number.', { show_alert: true });
  }
  await sendBaseContent(ctx, index, false);
  ctx.answerCbQuery(); // Acknowledge the callback
});

// Exit
bot.action('exit_base', async (ctx) => {
  // Delete the message and clear session
  if (ctx.session.baseMessageId) {
    await ctx.deleteMessage(ctx.session.baseMessageId).catch(() => {});
    ctx.session.baseMessageId = null;
  }
  await ctx.replyWithMarkdown('Thank you for learning about Base!');
  ctx.answerCbQuery();
});

// =================== Support ===================
bot.hears(/ℹ️\s*Support/i, async (ctx) => {
  await ctx.replyWithMarkdown('🛠️ *Support Section*\n\nSelect an option below:', Markup.inlineKeyboard([
    [Markup.button.callback('❓ How It Works', 'support_how_it_works')],
    [Markup.button.callback('⚠️ Transaction Not Received', 'support_not_received')],
    [Markup.button.callback('💬 Contact Support', 'support_contact')],
  ]));
});

// Support Actions
bot.action('support_how_it_works', async (ctx) => {
  await ctx.replyWithMarkdown(detailedTutorials.how_it_works);
  ctx.answerCbQuery();
});

bot.action('support_not_received', async (ctx) => {
  await ctx.replyWithMarkdown(detailedTutorials.transaction_guide);
  ctx.answerCbQuery();
});

bot.action('support_contact', async (ctx) => {
  await ctx.replyWithMarkdown('You can contact our support team at [@your_support_username](https://t.me/your_support_username).');
  ctx.answerCbQuery();
});

// =================== Transactions  ===================
bot.hears(/💰\s*Transactions/i, async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const pageSize = 5; // Number of transactions per page
    const userState = await getUserState(userId);
    const totalPages = Math.ceil(userState.wallets.length / pageSize) || 1;
    ctx.session.transactionsPage = 1; // Initialize to first page

    const generateTransactionPage = (page) => {
      const start = (page - 1) * pageSize;
      const end = start + pageSize;
      const transactions = userState.wallets.slice(start, end);

      let message = `💰 *Your Transactions* (Page ${page}/${totalPages}):\n\n`;
      transactions.forEach((tx, index) => {
        message += `*Transaction ${start + index + 1}:*\n`;
        message += `• *Reference ID:* \`${tx.referenceId || 'N/A'}\`\n`;
        message += `• *Amount:* ${tx.amount || 'N/A'} ${tx.asset || 'N/A'}\n`;
        message += `• *Status:* ${tx.status || 'Pending'}\n`;
        message += `• *Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n`;
        message += `• *Chain:* ${tx.chain || 'N/A'}\n\n`;
      });

      const navigationButtons = [];

      if (page > 1) {
        navigationButtons.push(Markup.button.callback('⬅️ Previous', `transaction_page_${page - 1}`));
      }
      if (page < totalPages) {
        navigationButtons.push(Markup.button.callback('Next ➡️', `transaction_page_${page + 1}`));
      }
      navigationButtons.push(Markup.button.callback('🔄 Refresh', `transaction_page_${page}`));

      const inlineKeyboard = Markup.inlineKeyboard([navigationButtons]);

      return { message, inlineKeyboard };
    };

    const { message, inlineKeyboard } = generateTransactionPage(ctx.session.transactionsPage);
    await ctx.replyWithMarkdown(message, inlineKeyboard);
  } catch (error) {
    logger.error(`Error fetching transactions for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ Unable to fetch transactions. Please try again later.');
  }
});

// Transaction Page Navigation
bot.action(/transaction_page_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const requestedPage = parseInt(ctx.match[1], 10);

  try {
    const pageSize = 5;
    const userState = await getUserState(userId);
    const totalPages = Math.ceil(userState.wallets.length / pageSize) || 1;

    if (requestedPage < 1 || requestedPage > totalPages) {
      return ctx.answerCbQuery('⚠️ Invalid page number.', { show_alert: true });
    }

    ctx.session.transactionsPage = requestedPage;

    const start = (requestedPage - 1) * pageSize;
    const end = start + pageSize;
    const transactions = userState.wallets.slice(start, end);

    let message = `💰 *Your Transactions* (Page ${requestedPage}/${totalPages}):\n\n`;
    transactions.forEach((tx, index) => {
      message += `*Transaction ${start + index + 1}:*\n`;
      message += `• *Reference ID:* \`${tx.referenceId || 'N/A'}\`\n`;
      message += `• *Amount:* ${tx.amount || 'N/A'} ${tx.asset || 'N/A'}\n`;
      message += `• *Status:* ${tx.status || 'Pending'}\n`;
      message += `• *Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n`;
      message += `• *Chain:* ${tx.chain || 'N/A'}\n\n`;
    });

    const navigationButtons = [];

    if (requestedPage > 1) {
      navigationButtons.push(Markup.button.callback('⬅️ Previous', `transaction_page_${requestedPage - 1}`));
    }
    if (requestedPage < totalPages) {
      navigationButtons.push(Markup.button.callback('Next ➡️', `transaction_page_${requestedPage + 1}`));
    }
    navigationButtons.push(Markup.button.callback('🔄 Refresh', `transaction_page_${requestedPage}`));

    const inlineKeyboard = Markup.inlineKeyboard([navigationButtons]);

    await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: inlineKeyboard.reply_markup });
    ctx.answerCbQuery(); // Acknowledge the callback
  } catch (error) {
    logger.error(`Error navigating transaction pages for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while navigating transactions. Please try again later.');
    ctx.answerCbQuery();
  }
});

// =================== Admin Menu ===================

// Entry point for Admin Panel
bot.action('open_admin_panel', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    return ctx.reply('⚠️ Unauthorized access.');
  }

  // Reset session variables if necessary
  ctx.session.adminMessageId = null;

  const sentMessage = await ctx.reply('👨‍💼 **Admin Panel**\n\nSelect an option below:', getAdminMenu());
  ctx.session.adminMessageId = sentMessage.message_id;

  // Removed the inactivity timeout as per user request
});

// Handle Admin Menu Actions
bot.action(/admin_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();

  if (!isAdmin(userId)) {
    return ctx.reply('⚠️ Unauthorized access.');
  }

  const action = ctx.match[1];

  switch (action) {
    case 'view_transactions':
      // Handle viewing transactions
      try {
        const transactionsSnapshot = await db.collection('transactions').orderBy('timestamp', 'desc').limit(10).get();

        if (transactionsSnapshot.empty) {
          await ctx.answerCbQuery('No transactions found.', { show_alert: true });
          return;
        }

        let message = '📋 **Recent Transactions**:\n\n';

        transactionsSnapshot.forEach((doc) => {
          const tx = doc.data();
          message += `*User ID:* ${tx.userId || 'N/A'}\n`;
          message += `*Reference ID:* \`${tx.referenceId || 'N/A'}\`\n`;
          message += `*Amount:* ${tx.amount || 'N/A'} ${tx.asset || 'N/A'}\n`;
          message += `*Status:* ${tx.status || 'Pending'}\n`;
          message += `*Chain:* ${tx.chain || 'N/A'}\n`;
          message += `*Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n\n`;
        });

        // Add a 'Back' button to return to the admin menu
        const inlineKeyboard = Markup.inlineKeyboard([
          [Markup.button.callback('🔙 Back to Admin Menu', 'admin_back_to_main')]
        ]);

        // Edit the admin panel message
        await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: inlineKeyboard.reply_markup });
        ctx.answerCbQuery();
      } catch (error) {
        logger.error(`Error fetching all transactions: ${error.message}`);
        await ctx.answerCbQuery('⚠️ Unable to fetch transactions.', { show_alert: true });
      }
      break;

    case 'send_message':
      // Handle sending messages
      if (ctx.session.adminMessageId) {
        await ctx.deleteMessage(ctx.session.adminMessageId).catch(() => {});
        ctx.session.adminMessageId = null;
      }
      await ctx.scene.enter('send_message_scene');
      ctx.answerCbQuery();
      break;

    case 'mark_paid':
      // Handle marking transactions as paid as a backup for admin 
      try {
        const pendingTransactions = await db.collection('transactions').where('status', '==', 'Pending').get();
        if (pendingTransactions.empty) {
          await ctx.answerCbQuery('No pending transactions found.', { show_alert: true });
          return;
        }

        const batch = db.batch();
        pendingTransactions.forEach((transaction) => {
          const docRef = db.collection('transactions').doc(transaction.id);
          batch.update(docRef, { status: 'Paid' });
        });

        await batch.commit();

        // Notify users about their transactions being marked as paid
        pendingTransactions.forEach(async (transaction) => {
          const txData = transaction.data();
          try {
            const payout = txData.payout || 'N/A';
            const accountName = txData.bankDetails && txData.bankDetails.accountName ? txData.bankDetails.accountName : 'Valued User';

            await bot.telegram.sendMessage(
              txData.userId,
              `🎉 *Transaction Successful!*\n\n` +
              `*Reference ID:* \`${txData.referenceId || 'N/A'}\`\n` +
              `*Amount Paid:* ${txData.amount} ${txData.asset}\n` +
              `*Bank:* ${txData.bankDetails.bankName || 'N/A'}\n` +
              `*Account Name:* ${accountName}\n` +
              `*Account Number:* ****${txData.bankDetails.accountNumber.slice(-4)}\n` +
              `*Payout (NGN):* ₦${payout}\n\n` +
              `🔹 *Chain:* ${txData.chain}\n` +
              `*Date:* ${new Date(txData.timestamp).toLocaleString()}\n\n` +
              `Thank you for using *DirectPay*! Your funds have been securely transferred to your bank account.`,
              { parse_mode: 'Markdown' }
            );
            logger.info(`Notified user ${txData.userId} about paid transaction ${txData.referenceId}`);
          } catch (error) {
            logger.error(`Error notifying user ${txData.userId}: ${error.message}`);
          }
        });

        // Edit the admin panel message to confirm
        await ctx.editMessageText('✅ All pending transactions have been marked as paid.', { reply_markup: getAdminMenu() });
        ctx.answerCbQuery();
      } catch (error) {
        logger.error(`Error marking transactions as paid: ${error.message}`);
        await ctx.answerCbQuery('⚠️ Error marking transactions as paid. Please try again later.', { show_alert: true });
      }
      break;

    case 'view_users':
      // Handle viewing all users
      try {
        const usersSnapshot = await db.collection('users').get();

        if (usersSnapshot.empty) {
          await ctx.answerCbQuery('No users found.', { show_alert: true });
          return;
        }

        let message = '👥 **All Users**:\n\n';

        usersSnapshot.forEach((doc) => {
          const user = doc.data();
          message += `*User ID:* ${doc.id}\n`;
          message += `*First Name:* ${user.firstName || 'N/A'}\n`;
          message += `*Number of Wallets:* ${user.wallets.length}\n`;
          message += `*Bank Linked:* ${user.wallets.some(wallet => wallet.bank) ? 'Yes' : 'No'}\n\n`;
        });

        // back to main menu
        const inlineKeyboard = Markup.inlineKeyboard([
          [Markup.button.callback('🔙 Back to Admin Menu', 'admin_back_to_main')]
        ]);

        // Edit the admin panel message
        await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: inlineKeyboard.reply_markup });
        ctx.answerCbQuery();
      } catch (error) {
        logger.error(`Error fetching all users: ${error.message}`);
        await ctx.answerCbQuery('⚠️ Unable to fetch users.', { show_alert: true });
      }
      break;

    case 'broadcast_message':
      // Handle sending broadcast messages to all users
      try {
        const usersSnapshot = await db.collection('users').get();
        if (usersSnapshot.empty) {
          await ctx.replyWithMarkdown('⚠️ No users available to broadcast.');
          return ctx.answerCbQuery();
        }

        await ctx.reply('📢 Please enter the message you want to broadcast to all users. You can also attach an image (receipt) with your message:');
        // Set state to indicate awaiting broadcast message
        await updateUserState(userId, { awaitingBroadcastMessage: true });
        // Delete the admin panel message to keep chat clean
        if (ctx.session.adminMessageId) {
          await ctx.deleteMessage(ctx.session.adminMessageId).catch(() => {});
          ctx.session.adminMessageId = null;
        }
        ctx.answerCbQuery();
      } catch (error) {
        logger.error(`Error initiating broadcast message: ${error.message}`);
        await ctx.replyWithMarkdown('⚠️ An error occurred while initiating the broadcast. Please try again later.');
        ctx.answerCbQuery();
      }
      break;

    case 'manage_banks':
      // Implement bank management functionalities here
      await ctx.replyWithMarkdown('🏦 **Bank Management**\n\nComing Soon!', { parse_mode: 'Markdown', reply_markup: getAdminMenu().reply_markup });
      ctx.answerCbQuery();
      break;

    case 'admin_back_to_main':
      // Return to the main menu
      await greetUser(ctx);
      // Delete the admin panel message
      if (ctx.session.adminMessageId) {
        await ctx.deleteMessage(ctx.session.adminMessageId).catch(() => {});
        ctx.session.adminMessageId = null;
      }
      ctx.answerCbQuery();
      break;

    default:
      await ctx.answerCbQuery('⚠️ Unknown action. Please select an option from the menu.', { show_alert: true });
  }
});

// =================== Send Message to User from Admin Panel ===================
// Already defined earlier

// =================== Bank Linking Scene ===================
// Already defined earlier

// =================== Verify Paycrest Signature ===================

function verifyPaycrestSignature(requestBody, signatureHeader, secretKey) {
  const hmac = crypto.createHmac('sha256', secretKey);
  hmac.update(requestBody);
  const calculatedSignature = hmac.digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(calculatedSignature), Buffer.from(signatureHeader));
  } catch (error) {
    // If buffer lengths are not equal, timingSafeEqual throws an error
    return false;
  }
}

// =================== Paycrest Webhook Handler ===================
app.post('/webhook/paycrest', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-paycrest-signature'];
  const rawBody = req.body; // Buffer

  if (!signature) {
    logger.error('No Paycrest signature found in headers.');
    return res.status(400).send('Signature missing.');
  }

  if (!verifyPaycrestSignature(rawBody, signature, PAYCREST_CLIENT_SECRET)) {
    logger.error('Invalid Paycrest signature.');
    return res.status(401).send('Invalid signature.');
  }

  let parsedBody;
  try {
    parsedBody = JSON.parse(rawBody.toString());
  } catch (error) {
    logger.error(`Failed to parse Paycrest webhook body: ${error.message}`);
    return res.status(400).send('Invalid JSON.');
  }

  const event = parsedBody.event;
  const data = parsedBody.data;

  // Log the received event for debugging purposes
  logger.info(`Received Paycrest event: ${event}`);

  try {
    // Extract common data
    const orderId = data.id;
    const status = data.status; 
    const amountPaid = parseFloat(data.amountPaid) || 0;
    const reference = data.reference;
    const returnAddress = data.returnAddress;

    // Fetch the transaction by Paycrest order ID
    const txSnapshot = await db.collection('transactions').where('paycrestOrderId', '==', orderId).limit(1).get();

    if (txSnapshot.empty) {
      logger.error(`No transaction found for Paycrest orderId: ${orderId}`);
      await bot.telegram.sendMessage(
        PERSONAL_CHAT_ID, 
        `❗️ No transaction found for Paycrest orderId: \`${orderId}\``, 
        { parse_mode: 'Markdown' }
      );
      return res.status(200).send('OK');
    }

    const txDoc = txSnapshot.docs[0];
    const txData = txDoc.data();
    const userId = txData.userId;
    const userFirstName = txData.firstName || 'Valued User';

    // Switch based on the 'event' field instead of 'status'
    switch (event) {
      case 'payment_order.pending':
        await bot.telegram.sendMessage(
          userId, 
          `⏳ *Your DirectPay order is pending processing.*\n\n` +
          `*Reference ID:* \`${reference}\`\n` +
          `*Amount:* ₦${amountPaid}\n` +
          `*Status:* Pending\n\n` +
          `We are currently processing your order. Please wait for further updates.`, 
          { parse_mode: 'Markdown' }
        );

        // Log to admin
        await bot.telegram.sendMessage(
          PERSONAL_CHAT_ID, 
          `🔄 *Payment Order Pending*\n\n` +
          `*User:* ${userFirstName} (ID: ${userId})\n` +
          `*Reference ID:* ${reference}\n` +
          `*Amount Paid:* ₦${amountPaid}\n`, 
          { parse_mode: 'Markdown' }
        );
        break;

      case 'payment_order.settled':
        await bot.telegram.sendMessage(
          userId, 
          `🎉 *Funds Credited Successfully!*\n\n` +
          `Hello ${userFirstName},\n\n` +
          `Your DirectPay order has been completed. Here are the details of your order:\n\n` +
          `*Crypto amount:* ${txData.amount} ${txData.asset}\n` +
          `*Cash amount:* NGN ${amountPaid}\n` +
          `*Network:* ${txData.chain}\n` +
          `*Date:* ${new Date(txData.timestamp).toLocaleString()}\n\n` + 
          `Thank you 💙.`,
          { parse_mode: 'Markdown' }
        );

        // Update transaction status in Firestore
        await db.collection('transactions').doc(txDoc.id).update({ status: 'Completed' });

        // Log to admin
        await bot.telegram.sendMessage(
          PERSONAL_CHAT_ID, 
          `✅ *Payment Order Settled*\n\n` +
          `*User:* ${userFirstName} (ID: ${userId})\n` +
          `*Reference ID:* ${reference}\n` +
          `*Amount Paid:* ₦${amountPaid}\n`, 
          { parse_mode: 'Markdown' }
        );
        break;

      case 'payment_order.expired':
        await bot.telegram.sendMessage(
          userId, 
          `⚠️ *Your DirectPay order has expired.*\n\n` +
          `Hello ${userFirstName},\n\n` +
          `We regret to inform you that your DirectPay order with *Reference ID:* \`${reference}\` has expired.\n\n` +
          `*Reason:* We experienced issues while processing your order. Rest assured, the funds have been returned to your original payment method.\n\n` +
          `If you believe this is a mistake or need further assistance, please don't hesitate to contact our support team.\n\n` +
          `Thank you for your understanding.`,
          { parse_mode: 'Markdown' }
        );

        // Update transaction status in Firestore
        await db.collection('transactions').doc(txDoc.id).update({ status: 'Expired' });

        // Log to admin
        await bot.telegram.sendMessage(
          PERSONAL_CHAT_ID, 
          `⏰ *Payment Order Expired*\n\n` +
          `*User:* ${userFirstName} (ID: ${userId})\n` +
          `*Reference ID:* ${reference}\n`, 
          { parse_mode: 'Markdown' }
        );
        break;

      case 'payment_order.refunded':
        await bot.telegram.sendMessage(
          userId, 
          `❌ *Your DirectPay order has been refunded.*\n\n` +
          `Hello ${userFirstName},\n\n` +
          `We regret to inform you that your DirectPay order with *Reference ID:* \`${reference}\` has been refunded.\n\n` +
          `*Reason:* We experienced issues while processing your order. Rest assured, the funds have been returned to your original payment method.\n\n` +
          `If you believe this is a mistake or need further assistance, please don't hesitate to contact our support team.\n\n` +
          `Thank you for your understanding.`,
          { parse_mode: 'Markdown' }
        );

        // Update transaction status in Firestore
        await db.collection('transactions').doc(txDoc.id).update({ status: 'Refunded' });

        // Log to admin
        await bot.telegram.sendMessage(
          PERSONAL_CHAT_ID, 
          `🔄 *Payment Order Refunded*\n\n` +
          `*User:* ${userFirstName} (ID: ${userId})\n` +
          `*Reference ID:* ${reference}\n` +
          `*Amount Paid:* ₦${amountPaid}\n`, 
          { parse_mode: 'Markdown' }
        );
        break;

      default:
        logger.info(`Unhandled Paycrest event type: ${event}`);
    }

    res.status(200).send('OK');
  } catch (error) {
    logger.error(`Error processing Paycrest webhook: ${error.message}`);
    await bot.telegram.sendMessage(
      PERSONAL_CHAT_ID, 
      `❗️ Error processing Paycrest webhook: ${error.message}`, 
      { parse_mode: 'Markdown' }
    );
    res.status(500).send('Error');
  }
});

// =================== Blockradar Webhook Handler ===================
app.post('/webhook/blockradar', async (req, res) => {
  try {
    const event = req.body;
    logger.info(`Received Blockradar webhook: ${JSON.stringify(event)}`);
    fs.appendFileSync(path.join(__dirname, 'webhook_logs.txt'), `${new Date().toISOString()} - ${JSON.stringify(event, null, 2)}\n`);

    // Extract common event data
    const eventType = event.event || 'Unknown Event';
    const walletAddress = event.data?.recipientAddress || 'N/A';
    const amount = parseFloat(event.data?.amount) || 0;
    const asset = event.data?.asset?.symbol || 'N/A';
    const transactionHash = event.data?.hash || 'N/A';
    const chainRaw = event.data?.blockchain?.name || 'N/A';
    const senderAddress = event.data?.senderAddress || 'N/A'; 
    
    // Normalize and map the chain name for ease
    const chainKey = chainMapping[chainRaw.toLowerCase()];
    if (!chainKey) {
      logger.error(`Unknown chain received in webhook: ${chainRaw}`);
      // Notify admin about the unknown chain
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ Received deposit on unknown chain: \`${chainRaw}\``);
      return res.status(400).send('Unknown chain.');
    }

    const chain = chainKey;

    if (eventType === 'deposit.success') { // Handle 'deposit.success' event
      if (walletAddress === 'N/A') {
        logger.error('Webhook missing wallet address.');
        return res.status(400).send('Missing wallet address.');
      }

      // **Duplicate Check Start**
      // Check if a transaction with the same hash already exists
      const existingTxSnapshot = await db.collection('transactions').where('transactionHash', '==', transactionHash).get();
      if (!existingTxSnapshot.empty) {
        logger.info(`Transaction with hash ${transactionHash} already exists. Skipping.`);
        return res.status(200).send('OK');
      }
      // **Duplicate Check End**

      // Find user by wallet address
      const usersSnapshot = await db.collection('users').where('walletAddresses', 'array-contains', walletAddress).get();
      if (usersSnapshot.empty) {
        logger.warn(`No user found for wallet ${walletAddress}`);
        // Notify admin about the unmatched wallet
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ No user found for wallet address: \`${walletAddress}\``);
        return res.status(200).send('OK');
      }

      const userDoc = usersSnapshot.docs[0];
      const userId = userDoc.id;
      const userState = userDoc.data();
      const wallet = userState.wallets.find((w) => w.address === walletAddress);

      // Check if Wallet has Linked Bank
      if (!wallet || !wallet.bank) {
        await bot.telegram.sendMessage(userId, `💰 *Deposit Received:* ${amount} ${asset} on ${chainRaw}.\n\nPlease link a bank account to receive your payout securely.`, { parse_mode: 'Markdown' });
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ User ${userId} has received a deposit but hasn't linked a bank account.`, { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      }

      // Only support USDC and USDT
      if (!SUPPORTED_ASSETS.includes(asset)) {
        await bot.telegram.sendMessage(userId, `⚠️ *Unsupported Asset Deposited:* ${asset}.\n\nCurrently, only *USDC* and *USDT* are supported. Please contact support if you believe this is an error.`, { parse_mode: 'Markdown' });
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ User ${userId} deposited unsupported asset: ${asset}.`, { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      }

      // Get the latest exchange rate (ensure exchangeRates are updated dynamically)
      const rate = exchangeRates[asset];
      if (!rate) {
        throw new Error(`Exchange rate for ${asset} not available.`);
      }

      // Calculate the NGN amount based on the current exchange rate
      const ngnAmount = calculatePayout(asset, amount);

      const referenceId = generateReferenceId();
      const bankName = wallet.bank.bankName || 'N/A';
      const bankAccount = wallet.bank.accountNumber || 'N/A';
      const accountName = wallet.bank.accountName || 'Valued User';

      // Fetch the user's first name
      const userFirstName = userState.firstName || 'Valued User';

      // Create Transaction Document with Status 'Processing' and store messageId as null at first
      const transactionRef = await db.collection('transactions').add({
        userId,
        walletAddress,
        chain: chainRaw,
        amount: amount,
        asset: asset,
        transactionHash: transactionHash,
        referenceId: referenceId,
        bankDetails: wallet.bank,
        payout: ngnAmount, // Store NGN payout
        timestamp: new Date().toISOString(),
        status: 'Processing',
        paycrestOrderId: '', // To be updated upon Paycrest order creation
        messageId: null, // To be set after sending the pending message
        firstName: userFirstName // Added firstName here
      });

      // Send Detailed Pending Message to User
      const pendingMessage = await bot.telegram.sendMessage(userId,
        `🎉 *Deposit Received!*\n\n` +
        `*Reference ID:* \`${referenceId}\`\n` +
        `*Amount Deposited:* ${amount} ${asset}\n` +
        `*Exchange Rate:* ₦${rate} per ${asset}\n` + 
        `*Network:* ${chainRaw}\n\n` +
        `🔄 *Your order has begun processing!* ⏳\n\n` +
        `We are converting your crypto to NGN at the current exchange rate of ₦${rate} per ${asset}. Your cash will be credited to your linked bank account shortly.\n\n` +
        `Thank you for using *DirectPay*!`,
        { parse_mode: 'Markdown' }
      );

      // Update the transaction document with message_id
      await transactionRef.update({
        messageId: pendingMessage.message_id
      });

      // Notify admin with detailed deposit information
      const adminDepositMessage = `⚡️ *New Deposit Received*\n\n` +
        `*User ID:* ${userId}\n` +
        `*Amount Deposited:* ${amount} ${asset}\n` +
        `*Exchange Rate:* ₦${rate} per ${asset}\n` +
        `*Amount to be Paid:* ₦${ngnAmount}\n` +
        `*Time:* ${new Date().toLocaleString()}\n` +
        `*Bank Details:*\n` +
        `  - *Account Name:* ${accountName}\n` +
        `  - *Bank Name:* ${bankName}\n` +
        `  - *Account Number:* ****${bankAccount.slice(-4)}\n` +
        `*Chain:* ${chainRaw}\n` +
        `*Transaction Hash:* \`${transactionHash}\`\n` +
        `*Reference ID:* ${referenceId}\n`;
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, adminDepositMessage, { parse_mode: 'Markdown' });

      // Integrate Paycrest to off-ramp automatically
      const paycrestMapping = mapToPaycrest(asset, chainRaw);
      if (!paycrestMapping) {
        logger.error('No Paycrest mapping for this asset/chain.');
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ No Paycrest mapping found for asset ${asset} on chain ${chainRaw}.`);
        return res.status(200).send('OK');
      }

      // Create Paycrest order with returnAddress as senderAddress
      let paycrestOrder;
      try {
        paycrestOrder = await createPaycrestOrder(userId, amount, asset, chainRaw, wallet.bank, senderAddress); 
        await transactionRef.update({ paycrestOrderId: paycrestOrder.id });
      } catch (err) {
        logger.error(`Error creating Paycrest order for user ${userId}: ${err.message}`);
        // Notify admin about the failure
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error creating Paycrest order for user ${userId}: ${err.message}`, { parse_mode: 'Markdown' });
        // Update transaction status to 'Failed'
        await transactionRef.update({ status: 'Failed' });
        // Update user's pending message to indicate failure
        const failureMessage = `Hello ${userFirstName},\n\n` +
          `⚠️ *Your DirectPay order has failed to process.*\n\n` +
          `Please contact our support team for assistance.`;
        await bot.telegram.editMessageText(userId, pendingMessage.message_id, null, failureMessage, { parse_mode: 'Markdown' });
        return res.status(500).send('Paycrest order error');
      }

      const receiveAddress = paycrestOrder.receiveAddress;

      // Withdraw from Blockradar to Paycrest receiveAddress
      let blockradarAssetId;
      switch (asset) {
        case 'USDC':
          blockradarAssetId = chains[chain].assets['USDC'];
          break;
        case 'USDT':
          blockradarAssetId = chains[chain].assets['USDT'];
          break;
        default:
          throw new Error(`Unsupported asset: ${asset}`);
      }

      try {
        await withdrawFromBlockradar(chainRaw, blockradarAssetId, receiveAddress, amount, paycrestOrder.id, { userId, originalTxHash: transactionHash });
      } catch (err) {
        logger.error(`Error withdrawing from Blockradar for user ${userId}: ${err.response ? err.response.data.message : err.message}`);
        // Notify admin about this failure
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error withdrawing from Blockradar for user ${userId}: ${err.response ? err.response.data.message : err.message}`, { parse_mode: 'Markdown' });
        // Update transaction status to 'Failed'
        await transactionRef.update({ status: 'Failed' });
        // Update user's pending message to indicate failure
        const failureMessage = `Hello ${userFirstName},\n\n` +
          `⚠️ *Your DirectPay order has failed to process.*\n\n` +
          `Please contact our support team for assistance.`;
        await bot.telegram.editMessageText(userId, pendingMessage.message_id, null, failureMessage, { parse_mode: 'Markdown' });
        return res.status(500).send('Blockradar withdrawal error');
      }

      // Update transaction status to 'Pending'
      await db.collection('transactions').doc(transactionRef.id).update({ status: 'Pending' });

      logger.info(`Transaction stored for user ${userId}: Reference ID ${paycrestOrder.id}`);

      res.status(200).send('OK');
    }
  } catch (error) {
    logger.error(`Error processing Blockradar webhook: ${error.message}`);
    res.status(500).send('Error processing webhook');
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error processing Blockradar webhook: ${error.message}`);
  }
});

// =================== Shutdown on Render ===================
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
