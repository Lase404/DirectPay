// =================== Import Dependencies ===================
const express = require('express');
const { Telegraf, Markup, Scenes, session } = require('telegraf');
const admin = require('firebase-admin');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const winston = require('winston');
const PDFDocument = require('pdfkit'); // For PDF generation
const blobStream = require('blob-stream'); // For handling PDF streams
require('dotenv').config(); // Ensure to install dotenv and create a .env file

// =================== Logger Setup ===================
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

// =================== Environment Variables ===================

// Configuration & API Keys
const BOT_TOKEN = process.env.BOT_TOKEN;
const PAYCREST_API_KEY = process.env.PAYCREST_API_KEY; // Client ID
const PAYCREST_CLIENT_SECRET = process.env.PAYCREST_CLIENT_SECRET; // Client Secret
const PAYCREST_RATE_API_URL = process.env.PAYCREST_RATE_API_URL || 'https://api.paycrest.io/v1/rates'; // Paycrest Rate API Endpoint
const PAYCREST_RETURN_ADDRESS = process.env.PAYCREST_RETURN_ADDRESS || "0xYourReturnAddressHere"; // Paycrest Return Address

const PAYSTACK_API_KEY = process.env.PAYSTACK_API_KEY;

const PERSONAL_CHAT_ID = process.env.PERSONAL_CHAT_ID;
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => id.trim()) : [];
const MAX_WALLETS = parseInt(process.env.MAX_WALLETS, 10) || 5;

// Telegram Webhook Configuration
const TELEGRAM_WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/webhook/telegram'; // e.g., '/webhook/telegram'
const WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN; // e.g., 'https://your-domain.com'
const TELEGRAM_WEBHOOK_URL = `${WEBHOOK_DOMAIN}${TELEGRAM_WEBHOOK_PATH}`;

const BLOCKRADAR_API_KEY = process.env.BLOCKRADAR_API_KEY || 'YOUR_BLOCKRADAR_API_KEY';
const BLOCKRADAR_USDC_ASSET_ID = process.env.BLOCKRADAR_USDC_ASSET_ID || 'YOUR_BLOCKRADAR_USDC_ASSET_ID';
const BLOCKRADAR_USDT_ASSET_ID = process.env.BLOCKRADAR_USDT_ASSET_ID || 'YOUR_BLOCKRADAR_USDT_ASSET_ID';

// Supported Assets
const SUPPORTED_ASSETS = ['USDC', 'USDT'];

// =================== Exchange Rates ===================
let exchangeRates = {
  USDC: 0,
  USDT: 0
};

// Function to fetch exchange rates from Paycrest
async function fetchExchangeRate(asset) {
  try {
    const response = await axios.get(`${PAYCREST_RATE_API_URL}`, {
      headers: {
        'Authorization': `Bearer ${PAYCREST_API_KEY}`,
        'Content-Type': 'application/json'
      }
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

// Function to fetch exchange rates for all supported assets
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
    key: 'i76FL4yzaRuYXPUzskM0Piodo5r08iJ1FUTgpuiylSDqYIVlcdEcPv5df3kbTvw',
    address: '0xfBeEC99b731B97271FF31E518c84d4a0E24B1118',
    apiUrl: 'https://api.blockradar.co/v1/wallets/e31c44d6-0344-4ee1-bcd1-c88e89a9e3f1/addresses',
    supportedAssets: ['USDC', 'USDT'],
    network: 'Base'
  },
  Polygon: {
    id: 'f7d5b102-e94a-493a-8e0c-8da96fe70655',
    key: 'iXV8e72v9QLKcKfI4Nw8SkqKtEoyzAQFCFinIZKwj7pKUtFxaRMjlLCt5p3DZND',
    address: '0x9A52605A21e3bacD791579D980A975b258968041',
    apiUrl: 'https://api.blockradar.co/v1/wallets/f7d5b102-e94a-493a-8e0c-8da96fe70655/addresses',
    supportedAssets: ['USDC', 'USDT'],
    network: 'Polygon'
  },
  'BNB Smart Chain': {
    id: '2cab1ef2-8589-4ff9-9017-76cc4d067719',
    key: '6HGRj2cdzULDUbrjGHZftwNyHswUZojxA40mQp77e5vDzWqJ6v13w2iE4DBHzu',
    address: '0x9A52605A21e3bacD791579D980A975b258968041',
    apiUrl: 'https://api.blockradar.co/v1/wallets/2cab1ef2-8589-4ff9-9017-76cc4d067719/addresses',
    supportedAssets: ['USDT', 'USDC'],
    network: 'BNB Smart Chain'
  }
};

// Chain Mapping to Handle Variations in Chain Names
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
app.use(express.json());

// =================== Initialize Telegraf Bot ===================
const bot = new Telegraf(BOT_TOKEN);

// =================== Helper Functions ===================

// Verify Bank Account with Paystack
async function verifyBankAccount(accountNumber, bankCode) {
  try {
    const response = await axios.get(`https://api.paystack.co/bank/resolve`, { // Corrected the URL and syntax
      params: { account_number: accountNumber, bank_code: bankCode },
      headers: { Authorization: `Bearer ${PAYSTACK_API_KEY}` },
    });
    return response.data;
  } catch (error) {
    logger.error(`Error verifying bank account (${accountNumber}, ${bankCode}): ${error.response ? error.response.data.message : error.message}`);
    throw new Error('Failed to verify bank account. Please try again later.');
  }
}

// Calculate Payout Based on Asset Type Using Dynamic Rates from Paycrest
function calculatePayout(asset, amount) {
  const rate = exchangeRates[asset];
  if (!rate) {
    throw new Error(`Unsupported asset received: ${asset}`);
  }
  return (amount * rate).toFixed(2);
}

// Generate a Unique Reference ID for Transactions
function generateReferenceId() {
  return 'REF-' + Math.random().toString(36).substr(2, 9).toUpperCase();
}

// Map Chain/Asset to Paycrest Network/Token
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

// =================== Firestore Helper Functions ===================

// Get User State from Firestore
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

// Update User State in Firestore
async function updateUserState(userId, newState) {
  try {
    await db.collection('users').doc(userId).update(newState);
  } catch (error) {
    logger.error(`Error updating user state for ${userId}: ${error.message}`);
    throw error;
  }
}

// =================== Wallet Generation Function ===================
async function generateWallet(chain) {
  try {
    const response = await axios.post(
      chains[chain].apiUrl,
      { name: `DirectPay_User_Wallet_${chain}` },
      { headers: { 'x-api-key': chains[chain].key } }
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

// =================== Paycrest Order Creation Function ===================
async function createPaycrestOrder(userId, amount, token, network, recipientDetails) {
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

    // Construct the recipient object as per Paycrest API
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

    // Construct the payload
    const orderPayload = {
      amount: String(amount), // Token amount as string
      rate: String(rate), // Exchange rate as string from Paycrest Rate API
      network: paycrestMapping.network, // e.g., 'polygon', 'base', etc.
      token: paycrestMapping.token, // 'USDT' or 'USDC'
      recipient: recipient,
      returnAddress: PAYCREST_RETURN_ADDRESS, // Use environment variable
      feePercent: 2, // Example fee percentage
    };

    // Make the API request to Paycrest
    const orderResp = await axios.post('https://api.paycrest.io/v1/sender/orders', orderPayload, {
      headers: {
        'API-Key': PAYCREST_API_KEY,
        'Content-Type': 'application/json'
      }
    });

    // Check if the response is successful
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

// =================== Withdrawal Function ===================
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
        'x-api-key': BLOCKRADAR_API_KEY,
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

// =================== Exchange Rate Calculation Function ===================
function calculatePayout(asset, amount) {
  const rate = exchangeRates[asset];
  if (!rate) {
    throw new Error(`Unsupported asset received: ${asset}`);
  }
  return (amount * rate).toFixed(2);
}

// =================== Generate Reference ID Function ===================
function generateReferenceId() {
  return 'REF-' + Math.random().toString(36).substr(2, 9).toUpperCase();
}

// =================== Main Menu Function ===================
const getMainMenu = (walletExists, hasBankLinked) =>
  Markup.keyboard([
    [walletExists ? '💼 View Wallet' : '💼 Generate Wallet', hasBankLinked ? '⚙️ Settings' : '🏦 Link Bank Account'],
    ['💰 Transactions', 'ℹ️ Support', '📘 Learn About Base'],
    ['📈 View Current Rates'], // Added Refresh Rates Button
  ]).resize();

// =================== Settings Menu Function ===================
const getSettingsMenu = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Generate New Wallet', 'settings_generate_wallet')],
    [Markup.button.callback('✏️ Edit Linked Bank Details', 'settings_edit_bank')],
    [Markup.button.callback('💬 Support', 'settings_support')],
    [Markup.button.callback('🧾 Generate Transaction Receipt', 'settings_generate_receipt')],
    [Markup.button.callback('🔙 Back to Main Menu', 'settings_back_main')],
  ]);

// =================== Admin Menu Function ===================
const getAdminMenu = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('📋 View All Transactions', 'admin_view_transactions')],
    [Markup.button.callback('📩 Send Message to User', 'admin_send_message')],
    [Markup.button.callback('✅ Mark Transactions as Paid', 'admin_mark_paid')],
    [Markup.button.callback('👥 View All Users', 'admin_view_users')],
    [Markup.button.callback('📢 Broadcast Message', 'admin_broadcast_message')],
    [Markup.button.callback('🏦 Manage Banks', 'admin_manage_banks')],
    [Markup.button.callback('🔙 Back to Admin Menu', 'admin_back_to_main')],
  ]);

// =================== Check if User is Admin ===================
const isAdmin = (userId) => ADMIN_IDS.includes(userId.toString());

// =================== Greet User Function ===================
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

// =================== Handle /start Command ===================
bot.start(async (ctx) => {
  logger.info(`Received /start command from user ${ctx.from.id}`);
  try {
    await greetUser(ctx);
  } catch (error) {
    logger.error(`Error in /start command: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
  }
});

// =================== Handle "💼 Generate Wallet" Button ===================
bot.hears('💼 Generate Wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    
    if (userState.wallets.length >= MAX_WALLETS) {
      return ctx.replyWithMarkdown(`⚠️ You have reached the maximum number of wallets (${MAX_WALLETS}). Please manage your existing wallets before adding new ones.`);
    }
    
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

// =================== Handle "💼 View Wallet" Button ===================
bot.hears('💼 View Wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    
    if (userState.wallets.length === 0) {
      return ctx.replyWithMarkdown('❌ You have no wallets. Please generate a wallet first using the "💼 Generate Wallet" option.');
    }
    
    let message = '💼 *Your Wallets*:\n\n';
    userState.wallets.forEach((wallet, index) => {
      message += `*Wallet ${index + 1}:*\n`;
      message += `• *Chain:* ${wallet.chain}\n`;
      message += `• *Address:* \`${wallet.address}\`\n`;
      message += `• *Bank Linked:* ${wallet.bank ? '✅ Yes' : '❌ No'}\n\n`;
    });
    
    await ctx.replyWithMarkdown(message);
  } catch (error) {
    logger.error(`Error handling View Wallet for user ${userId}: ${error.message}`);
    await ctx.reply('⚠️ An error occurred while fetching your wallets. Please try again later.');
  }
});

// =================== Handle "⚙️ Settings" Button ===================
bot.hears('⚙️ Settings', async (ctx) => {
  await ctx.reply('⚙️ *Settings Menu*', getSettingsMenu());
});

// =================== Handle "🏦 Link Bank Account" Button ===================
bot.hears('🏦 Link Bank Account', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    
    if (userState.wallets.length === 0) {
      return ctx.replyWithMarkdown('❌ You have no wallets. Please generate a wallet first using the "💼 Generate Wallet" option.');
    }

    if (userState.wallets.length === 1) {
      // Only one wallet, proceed to link bank account
      ctx.session.walletIndex = 0;
      await ctx.scene.enter('bank_linking_scene');
    } else {
      // Multiple wallets, prompt user to select which wallet to link
      let keyboard = userState.wallets.map((wallet, index) => [
        Markup.button.callback(`Wallet ${index + 1} - ${wallet.chain}`, `select_wallet_${index}`)
      ]);
      await ctx.reply('Please select the wallet you want to link a bank account to:', Markup.inlineKeyboard(keyboard));
    }
  } catch (error) {
    logger.error(`Error handling Link Bank Account for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while initiating bank linking. Please try again later.');
  }
});

// =================== Handle "📈 View Current Rates" Button ===================
bot.hears(/📈\s*View Current Rates/i, async (ctx) => { // Added regex to match variations
  try {
    let message = '📈 *Current Exchange Rates*:\n\n';
    for (const [asset, rate] of Object.entries(exchangeRates)) {
      message += `• *${asset}*: ₦${rate}\n`;
    }
    // Add a refresh button
    message += `\nTo refresh the rates, press the "🔄 Refresh Rates" button below.`;
    await ctx.replyWithMarkdown(message, Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Refresh Rates', 'refresh_rates')]
    ]));
  } catch (error) {
    logger.error(`Error fetching exchange rates for user ${ctx.from.id}: ${error.message}`);
    await ctx.reply('⚠️ Unable to fetch exchange rates at the moment. Please try again later.');
  }
});

// =================== Handle "🔄 Refresh Rates" Button ===================
bot.action('refresh_rates', async (ctx) => {
  try {
    await fetchExchangeRates(); // Update exchange rates
    let message = '🔄 *Exchange Rates Refreshed*:\n\n';
    for (const [asset, rate] of Object.entries(exchangeRates)) {
      message += `• *${asset}*: ₦${rate}\n`;
    }
    message += `\n*Latest Rates:* Updated just now.`;
    await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Refresh Rates', 'refresh_rates')]
    ]).reply_markup });
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error refreshing exchange rates: ${error.message}`);
    await ctx.reply('⚠️ Unable to refresh exchange rates at the moment. Please try again later.');
    ctx.answerCbQuery();
  }
});

// =================== Handle Inline Wallet Selection ===================
bot.action(/select_wallet_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);
  
  try {
    const userState = await getUserState(userId);
    if (isNaN(walletIndex) || walletIndex < 0 || walletIndex >= userState.wallets.length) {
      await ctx.reply('⚠️ Invalid wallet selection.');
      return ctx.answerCbQuery();
    }

    ctx.session.walletIndex = walletIndex;
    await ctx.scene.enter('bank_linking_scene');
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error handling wallet selection for user ${userId}: ${error.message}`);
    await ctx.reply('⚠️ An error occurred. Please try again later.');
    ctx.answerCbQuery();
  }
});

// =================== Handle Edit Wallet Selection ===================
bot.action(/edit_wallet_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);
  
  try {
    const userState = await getUserState(userId);
    if (isNaN(walletIndex) || walletIndex < 0 || walletIndex >= userState.wallets.length) {
      await ctx.reply('⚠️ Invalid wallet selection.');
      return ctx.answerCbQuery();
    }

    ctx.session.walletIndex = walletIndex;
    await ctx.scene.enter('bank_linking_scene');
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error handling edit_wallet_${walletIndex} for user ${userId}: ${error.message}`);
    await ctx.reply('⚠️ An error occurred. Please try again later.');
    ctx.answerCbQuery();
  }
});

// =================== Handle Settings Actions ===================
bot.action('settings_generate_wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);

    if (userState.wallets.length >= MAX_WALLETS) {
      await ctx.replyWithMarkdown(`⚠️ You have reached the maximum number of wallets (${MAX_WALLETS}). Please manage your existing wallets before adding new ones.`);
      return ctx.answerCbQuery();
    }

    await ctx.reply('📂 *Select the network for which you want to generate a wallet:*', Markup.inlineKeyboard([
      [Markup.button.callback('Base', 'generate_wallet_Base')],
      [Markup.button.callback('Polygon', 'generate_wallet_Polygon')],
      [Markup.button.callback('BNB Smart Chain', 'generate_wallet_BNB Smart Chain')],
    ]));
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in settings_generate_wallet for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while generating your wallet. Please try again later.');
    ctx.answerCbQuery();
  }
});

bot.action('settings_edit_bank', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    
    if (userState.wallets.length === 0) {
      await ctx.replyWithMarkdown('❌ You have no wallets. Please generate a wallet first using the "💼 Generate Wallet" option.');
      return ctx.answerCbQuery();
    }

    if (userState.wallets.length === 1) {
      // Only one wallet, proceed to edit bank account
      ctx.session.walletIndex = 0;
      await ctx.scene.enter('bank_linking_scene');
    } else {
      // Multiple wallets, prompt user to select which wallet to edit
      let keyboard = userState.wallets.map((wallet, index) => [
        Markup.button.callback(`Wallet ${index + 1} - ${wallet.chain}`, `edit_wallet_${index}`)
      ]);
      await ctx.reply('Please select the wallet you want to edit the bank account for:', Markup.inlineKeyboard(keyboard));
    }
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in settings_edit_bank for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while editing your bank details. Please try again later.');
    ctx.answerCbQuery();
  }
});

bot.action('settings_support', async (ctx) => {
  await ctx.reply('🛠️ *Support Section*\n\nSelect an option below:', Markup.inlineKeyboard([
    [Markup.button.callback('📘 How It Works', 'support_how_it_works')],
    [Markup.button.callback('⚠️ Transaction Not Received', 'support_not_received')],
    [Markup.button.callback('💬 Contact Support', 'support_contact')],
    [Markup.button.callback('🔙 Back to Settings', 'settings_back_main')],
  ]));
});

bot.action('settings_back_main', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    const walletExists = userState.wallets.length > 0;
    const hasBankLinked = userState.wallets.some(wallet => wallet.bank);
    await ctx.reply('⚙️ *Settings Menu*', getSettingsMenu());
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error handling settings_back_main for user ${userId}: ${error.message}`);
    await ctx.reply('⚠️ An error occurred. Please try again later.');
    ctx.answerCbQuery();
  }
});

// =================== Admin Panel Handlers ===================
bot.action('open_admin_panel', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    return ctx.reply('⚠️ Unauthorized access.');
  }

  // Reset session variables if necessary
  ctx.session.adminMessageId = null;

  const sentMessage = await ctx.reply('👨‍💼 **Admin Panel**\n\nSelect an option below:', getAdminMenu());
  ctx.session.adminMessageId = sentMessage.message_id;

  // Set a timeout to delete the admin panel message after 5 minutes
  setTimeout(() => {
    if (ctx.session.adminMessageId) {
      ctx.deleteMessage(ctx.session.adminMessageId).catch(() => {});
      ctx.session.adminMessageId = null;
    }
  }, 300000); // Delete after 5 minutes

  ctx.answerCbQuery();
});

// Handle Admin Menu Actions
bot.action(/admin_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();

  if (!isAdmin(userId)) {
    return ctx.reply('⚠️ Unauthorized access.');
  }

  const adminAction = ctx.match[1];

  switch (adminAction) {
    case 'view_transactions':
      // Handle viewing transactions
      await handleAdminViewTransactions(ctx);
      break;
    case 'send_message':
      // Handle sending messages
      await ctx.scene.enter('send_message_scene');
      ctx.answerCbQuery();
      break;
    case 'mark_paid':
      // Handle marking transactions as paid as a backup
      await handleAdminMarkPaid(ctx);
      break;
    case 'view_users':
      // Handle viewing all users
      await handleAdminViewUsers(ctx);
      break;
    case 'broadcast_message':
      // Handle broadcasting messages
      await handleAdminBroadcastMessage(ctx);
      break;
    case 'manage_banks':
      // Implement bank management functionalities here
      await ctx.replyWithMarkdown('🏦 **Bank Management**\n\nComing Soon!', { parse_mode: 'Markdown', reply_markup: getAdminMenu().reply_markup });
      ctx.answerCbQuery();
      break;
    case 'back_to_main':
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

// =================== Handle Admin View Transactions ===================
async function handleAdminViewTransactions(ctx) {
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
      message += `*Reference ID:* \`${tx.referenceId}\`\n`;
      message += `*Amount:* ${tx.amount} ${tx.asset}\n`;
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
}

// =================== Handle Admin Mark Paid ===================
async function handleAdminMarkPaid(ctx) {
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
          `*Reference ID:* \`${txData.referenceId}\`\n` +
          `*Amount Paid:* ${txData.amount} ${txData.asset}\n` +
          `*Bank:* ${txData.bankDetails.bankName}\n` +
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
}

// =================== Handle Admin View Users ===================
async function handleAdminViewUsers(ctx) {
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

    // Add a 'Back' button to return to the admin menu
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
}

// =================== Handle Admin Broadcast Message ===================
async function handleAdminBroadcastMessage(ctx) {
  await ctx.reply('📢 Please enter the message you want to broadcast to all users. You can also attach an image (receipt) with your message:');
  // Set state to indicate awaiting broadcast message
  await updateUserState(ctx.from.id.toString(), { awaitingBroadcastMessage: true });
  // Delete the admin panel message to keep chat clean
  if (ctx.session.adminMessageId) {
    await ctx.deleteMessage(ctx.session.adminMessageId).catch(() => {});
    ctx.session.adminMessageId = null;
  }
}

// =================== Handle Admin Back to Main ===================
async function handleAdminBackToMain(ctx) {
  await greetUser(ctx);
  // Delete the admin panel message
  if (ctx.session.adminMessageId) {
    await ctx.deleteMessage(ctx.session.adminMessageId).catch(() => {});
    ctx.session.adminMessageId = null;
  }
}

// =================== Handle Admin Send Message to User ===================
async function handleAdminSendMessage(ctx) {
  await ctx.scene.enter('send_message_scene');
}

// =================== Receipt Generation Scene ===================
// Already defined in the Scenes Definitions section

// =================== Webhook Handlers ===================

// Function to Verify Paycrest Webhook Signature
function verifyPaycrestSignature(requestBody, signatureHeader, secretKey) {
  const calculatedSignature = calculateHmacSignature(requestBody, secretKey);
  return signatureHeader === calculatedSignature;
}

function calculateHmacSignature(data, secretKey) {
  const key = Buffer.from(secretKey);
  const hash = crypto.createHmac('sha256', key);
  hash.update(data);
  return hash.digest('hex');
}

// Paycrest Webhook Endpoint
app.post('/webhook/paycrest', async (req, res) => {
  const signature = req.headers['x-paycrest-signature'];
  const rawBody = JSON.stringify(req.body);

  if (!verifyPaycrestSignature(rawBody, signature, PAYCREST_CLIENT_SECRET)) {
    logger.error('Invalid Paycrest signature');
    return res.status(401).send('Invalid signature');
  }

  const event = req.body.event;
  const data = req.body.data;

  if (event === 'payment_order.settled') {
    const orderId = data.id;

    try {
      // Fetch transaction by paycrestOrderId
      const txSnapshot = await db.collection('transactions').where('paycrestOrderId', '==', orderId).limit(1).get();
      if (txSnapshot.empty) {
        logger.error(`No transaction found for Paycrest orderId: ${orderId}`);
        return res.status(200).send('OK');
      }

      const txDoc = txSnapshot.docs[0];
      const txData = txDoc.data();
      const userId = txData.userId;
      const messageId = txData.messageId;

      // Update transaction to Paid
      await db.collection('transactions').doc(txDoc.id).update({ status: 'Paid' });

      // Notify user
      await bot.telegram.sendMessage(userId, `🎉 *Funds Credited Successfully!*\n\n` +
        `Hello ${txData.firstName || 'Valued User'},\n\n` +
        `Your DirectPay order has been completed. Here are the details of your order:\n\n` +
        `*Crypto amount:* ${txData.amount} ${txData.asset}\n` +
        `*Cash amount:* NGN ${txData.payout}\n` +
        `*Network:* ${txData.chain}\n` +
        `*Date:* ${new Date(txData.timestamp).toISOString()}\n\n` +
        `To help us keep improving our services, please rate your experience with us.`,
        { parse_mode: 'Markdown' }
      );

      // Optionally, edit the pending message to indicate completion
      if (messageId) {
        try {
          await bot.telegram.editMessageText(userId, messageId, null, `🎉 *Funds Credited Successfully!*\n\n` +
            `Your DirectPay order has been completed. Here are the details of your order:\n\n` +
            `*Crypto amount:* ${txData.amount} ${txData.asset}\n` +
            `*Cash amount:* NGN ${txData.payout}\n` +
            `*Network:* ${txData.chain}\n` +
            `*Date:* ${new Date(txData.timestamp).toISOString()}\n\n` +
            `Thank you for using *DirectPay*! Your funds have been securely transferred to your bank account. If you have any questions or need further assistance, feel free to [contact our support team](https://t.me/maxcswap).`,
            { parse_mode: 'Markdown' }
          );
        } catch (error) {
          logger.error(`Error editing message for user ${userId}: ${error.message}`);
          // Optionally, notify admin about the failure to edit message
          await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Failed to edit message for user ${userId}: ${error.message}`);
        }
      }

      // Notify admin about the successful payment
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `✅ *Payment Completed*\n\n` +
        `*User ID:* ${userId}\n` +
        `*Reference ID:* ${txData.referenceId}\n` +
        `*Amount:* ${txData.amount} ${txData.asset}\n` +
        `*Bank:* ${txData.bankDetails.bankName}\n` +
        `*Account Number:* ****${txData.bankDetails.accountNumber.slice(-4)}\n` +
        `*Date:* ${new Date(txData.timestamp).toLocaleString()}\n`, { parse_mode: 'Markdown' });

      res.status(200).send('OK');
    } catch (error) {
      logger.error(`Error processing Paycrest webhook for orderId ${orderId}: ${error.message}`);
      res.status(500).send('Error');
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error processing Paycrest webhook for orderId ${orderId}: ${error.message}`);
    }
  } else {
    logger.info(`Unhandled Paycrest event: ${event}`);
    res.status(200).send('OK');
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

    // Normalize and map the chain name
    const chainKey = chainMapping[chainRaw.toLowerCase()];
    if (!chainKey) {
      logger.error(`Unknown chain received in webhook: ${chainRaw}`);
      // Notify admin about the unknown chain
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ Received deposit on unknown chain: \`${chainRaw}\``);
      return res.status(400).send('Unknown chain.');
    }

    const chain = chainKey;

    if (eventType === 'deposit.swept.success') { // Handle 'deposit.swept.success' event
      if (walletAddress === 'N/A') {
        logger.error('Webhook missing wallet address.');
        return res.status(400).send('Missing wallet address.');
      }

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

      // Create Transaction Document with Status 'Processing' and store messageId as null initially
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
        messageId: null // To be set after sending the pending message
      });

      // Send Pending Message to User
      const pendingMessage = await bot.telegram.sendMessage(userId,
        `Hello ${userFirstName},\n\n` +
        `Your DirectPay order is being processed... ⏳\n\n` +
        `Please wait while we credit your account.`,
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

      // Create Paycrest order
      let paycrestOrder;
      try {
        paycrestOrder = await createPaycrestOrder(userId, amount, asset, chainRaw, wallet.bank); // Pass token amount
        await transactionRef.update({ paycrestOrderId: paycrestOrder.id });
      } catch (err) {
        logger.error(`Error creating Paycrest order for user ${userId}: ${err.message}`);
        // Notify admin about the failure
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error creating Paycrest order for user ${userId}: ${err.message}`);
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
          blockradarAssetId = BLOCKRADAR_USDC_ASSET_ID;
          break;
        case 'USDT':
          blockradarAssetId = BLOCKRADAR_USDT_ASSET_ID;
          break;
        default:
          throw new Error(`Unsupported asset: ${asset}`);
      }

      try {
        await withdrawFromBlockradar(chainRaw, blockradarAssetId, receiveAddress, amount, paycrestOrder.id, { userId, originalTxHash: transactionHash });
      } catch (err) {
        logger.error(`Error withdrawing from Blockradar for user ${userId}: ${err.response ? err.response.data.message : err.message}`);
        // Notify admin about this failure
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error withdrawing from Blockradar for user ${userId}: ${err.response ? err.response.data.message : err.message}`);
        // Update transaction status to 'Failed'
        await transactionRef.update({ status: 'Failed' });
        // Update user's pending message to indicate failure
        const failureMessage = `Hello ${userFirstName},\n\n` +
          `⚠️ *Your DirectPay order has failed to process.*\n\n` +
          `Please contact our support team for assistance.`;
        await bot.telegram.editMessageText(userId, pendingMessage.message_id, null, failureMessage, { parse_mode: 'Markdown' });
        return res.status(500).send('Blockradar withdrawal error');
      }

      // Store Transaction in Firestore
      await db.collection('transactions').doc(transactionRef.id).update({
        status: 'Pending',
        paycrestOrderId: paycrestOrder.id
      });

      logger.info(`Transaction stored for user ${userId}: Reference ID ${paycrestOrder.id}`);

      // Update User's Pending Message to Final Success Message
      const finalMessage = `Hello ${userFirstName},\n\n` +
        `Your DirectPay order has been completed. Here are the details of your order:\n\n` +
        `*Crypto amount:* ${amount} ${asset}\n` +
        `*Cash amount:* NGN ${ngnAmount}\n` +
        `*Network:* ${chainRaw}\n` +
        `*Date:* ${new Date(txData.timestamp).toISOString()}\n\n` +
        `To help us keep improving our services, please rate your experience with us.`;

      try {
        await bot.telegram.editMessageText(userId, pendingMessage.message_id, null, finalMessage, { parse_mode: 'Markdown' });
        // Update transaction status to 'Completed'
        await db.collection('transactions').doc(transactionRef.id).update({ status: 'Completed' });
      } catch (error) {
        logger.error(`Error editing message for user ${userId}: ${error.message}`);
        // Optionally, notify admin about the failure to edit message
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Failed to edit message for user ${userId}: ${error.message}`);
      }

      // Reset Bank Linking Flags and Session Variables
      delete ctx.session.walletIndex;
      delete ctx.session.bankData;
      delete ctx.session.processType;
      delete ctx.session.isBankLinking; // Reset the bank linking flag

      // Clear the inactivity timeout
      if (ctx.session.bankLinkingTimeout) {
        clearTimeout(ctx.session.bankLinkingTimeout);
        delete ctx.session.bankLinkingTimeout;
      }

      res.status(200).send('OK');
    }
  } catch (error) {
    logger.error(`Error processing Blockradar webhook: ${error.message}`);
    res.status(500).send('Error processing webhook');
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error processing Blockradar webhook: ${error.message}`);
  }
});

// =================== Webhook Handlers End ===================

// =================== Support and Tutorial Content ===================
const detailedTutorials = {
  how_it_works: `
**📘 How DirectPay Works**

1. **Generate Your Wallet:**
   - Navigate to the "💼 Generate Wallet" option.
   - Select your preferred network (Base, Polygon, BNB Smart Chain).
   - Receive a unique wallet address where you can receive crypto payments.

2. **Link Your Bank Account:**
   - Go to "⚙️ Settings" > "🏦 Link Bank Account."
   - Provide your bank details to securely receive payouts directly into your bank account.

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
**🏦 How to Link or Edit Your Bank Account**

*Linking a New Bank Account:*

1. **Navigate to Bank Linking:**
   - Click on "⚙️ Settings" > "🏦 Link Bank Account" from the main menu.

2. **Select Your Wallet:**
   - If you have multiple wallets, select the one you want to link a bank account to.

3. **Provide Bank Details:**
   - Enter your bank name (e.g., Access Bank).
   - Input your 10-digit bank account number.

4. **Verify Account:**
   - DirectPay will verify your bank account details.
   - Confirm the displayed account holder name.

5. **Completion:**
   - Once verified, your bank account is linked and ready to receive payouts.

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

// =================== Base Content Pages ===================
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

// =================== Centralized Callback Query Handler ===================
bot.on('callback_query', async (ctx) => {
  const callbackData = ctx.callbackQuery.data;
  const userId = ctx.from.id.toString();

  // Log the callback for debugging
  logger.info(`Received callback: ${callbackData} from user: ${userId}`);

  // =================== Handle Generate Wallet Callbacks ===================
  if (callbackData.startsWith('generate_wallet_')) {
    const chain = callbackData.replace('generate_wallet_', '');
    await handleGenerateWallet(ctx, chain);
    return;
  }

  // =================== Handle Receipt Generation Callbacks ===================
  if (callbackData === 'receipt_all') {
    await handleReceiptAll(ctx);
    return;
  }

  if (callbackData === 'receipt_specific') {
    await handleReceiptSpecific(ctx);
    return;
  }

  if (callbackData.startsWith('select_tx_')) {
    const transactionId = callbackData.replace('select_tx_', '');
    await handleSelectTransaction(ctx, transactionId);
    return;
  }

  if (callbackData.startsWith('base_page_')) {
    const pageIndex = parseInt(callbackData.replace('base_page_', ''), 10);
    await handleBasePage(ctx, pageIndex);
    return;
  }

  // =================== Handle Admin Callbacks ===================
  if (callbackData.startsWith('admin_')) {
    const adminAction = callbackData.replace('admin_', '');
    await handleAdminActions(ctx, adminAction);
    return;
  }

  // =================== Handle Settings Callbacks ===================
  switch (callbackData) {
    case 'settings_generate_wallet':
      await handleSettingsGenerateWallet(ctx);
      break;
    case 'settings_edit_bank':
      await handleSettingsEditBank(ctx);
      break;
    case 'settings_support':
      await handleSettingsSupport(ctx);
      break;
    case 'settings_generate_receipt':
      await ctx.scene.enter('receipt_generation_scene');
      break;
    case 'settings_back_main':
      await greetUser(ctx);
      break;
    case 'support_how_it_works':
      await ctx.replyWithMarkdown(detailedTutorials.how_it_works);
      break;
    case 'support_not_received':
      await ctx.replyWithMarkdown(detailedTutorials.transaction_guide);
      break;
    case 'support_contact':
      await ctx.replyWithMarkdown('You can contact our support team at [@maxcswap](https://t.me/maxcswap).');
      break;
    case 'exit_base':
      if (ctx.session.baseMessageId) {
        await ctx.deleteMessage(ctx.session.baseMessageId).catch(() => {});
        ctx.session.baseMessageId = null;
      }
      await ctx.replyWithMarkdown('Thank you for learning about Base!');
      break;
    default:
      // Handle unknown callbacks or leave them to other handlers
      logger.warn(`Unhandled callback data: ${callbackData}`);
      await ctx.answerCbQuery('⚠️ Unknown action.', { show_alert: true });
  }

  // Acknowledge the callback to remove the loading state
  await ctx.answerCbQuery();
});

// =================== Handle "📘 Learn About Base" Button ===================
bot.hears(/📘\s*Learn About Base/i, async (ctx) => {
  await sendBaseContent(ctx, 0, true);
});

// =================== Support Functionality ===================
bot.hears(/ℹ️\s*Support/i, async (ctx) => {
  await ctx.reply('🛠️ *Support Section*\n\nSelect an option below:', Markup.inlineKeyboard([
    [Markup.button.callback('📘 How It Works', 'support_how_it_works')],
    [Markup.button.callback('⚠️ Transaction Not Received', 'support_not_received')],
    [Markup.button.callback('💬 Contact Support', 'support_contact')],
    [Markup.button.callback('🔙 Back to Settings', 'settings_back_main')],
  ]));
});

// =================== Handle Support Actions ===================
bot.action('support_how_it_works', async (ctx) => {
  await ctx.replyWithMarkdown(detailedTutorials.how_it_works);
  ctx.answerCbQuery();
});

bot.action('support_not_received', async (ctx) => {
  await ctx.replyWithMarkdown(detailedTutorials.transaction_guide);
  ctx.answerCbQuery();
});

bot.action('support_contact', async (ctx) => {
  await ctx.replyWithMarkdown('You can contact our support team at [@maxcswap](https://t.me/maxcswap).');
  ctx.answerCbQuery();
});

// =================== Handle "💰 Transactions" Button ===================
bot.hears(/💰\s*Transactions/i, async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const transactionsSnapshot = await db.collection('transactions').where('userId', '==', userId).orderBy('timestamp', 'desc').get();

    if (transactionsSnapshot.empty) {
      return await ctx.replyWithMarkdown('You have no transactions at the moment.');
    }

    let message = '💰 *Your Transactions*:\n\n';

    transactionsSnapshot.forEach((doc) => {
      const tx = doc.data();
      message += `*Reference ID:* \`${tx.referenceId}\`\n`;
      message += `*Amount:* ${tx.amount} ${tx.asset}\n`;
      message += `*Status:* ${tx.status}\n`;
      message += `*Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n`;
      message += `*Chain:* ${tx.chain}\n\n`;
    });

    await ctx.replyWithMarkdown(message);
  } catch (error) {
    logger.error(`Error fetching transactions for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ Unable to fetch transactions. Please try again later.');
  }
});

// =================== Admin Panel Functionality ===================
// Handled above with Admin Menu Handlers

// =================== Receipt Generation Scene ===================
// Handled above with Receipt Generation Scene Definition

// =================== Graceful Shutdown ===================
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// =================== Additional Handler Functions ===================

// Handle Receipt Generation (All Transactions)
async function handleReceiptAll(ctx) {
  const userId = ctx.from.id.toString();
  try {
    // Fetch all transactions for the user
    const transactionsSnapshot = await db.collection('transactions').where('userId', '==', userId).orderBy('timestamp', 'desc').get();
    if (transactionsSnapshot.empty) {
      await ctx.reply('❌ You have no transactions to generate a receipt.');
      return ctx.scene.leave();
    }

    // Generate PDF receipt
    const doc = new PDFDocument();
    const stream = doc.pipe(blobStream());

    doc.fontSize(20).text('Transaction Receipt', { align: 'center' });
    doc.moveDown();

    transactionsSnapshot.forEach((docData, index) => {
      const tx = docData.data();
      doc.fontSize(12).text(`Transaction ${index + 1}:`);
      doc.text(`Reference ID: ${tx.referenceId}`);
      doc.text(`Amount: ${tx.amount} ${tx.asset}`);
      doc.text(`Status: ${tx.status}`);
      doc.text(`Date: ${new Date(tx.timestamp).toLocaleString()}`);
      doc.text(`Chain: ${tx.chain}`);
      doc.moveDown();
    });

    doc.end();

    // Wait for the PDF to be fully generated
    stream.on('finish', async () => {
      const buffer = stream.toBlob('application/pdf');
      const bufferArray = Buffer.from(await buffer.arrayBuffer());

      // Send the PDF to the user
      await ctx.replyWithDocument({ source: bufferArray, filename: 'Transaction_Receipt.pdf' });
      await ctx.reply('✅ Your transaction receipt has been generated and sent.');
      ctx.scene.leave();
    });
  } catch (error) {
    logger.error(`Error generating all transactions receipt for user ${userId}: ${error.message}`);
    await ctx.reply('⚠️ An error occurred while generating your receipt. Please try again later.');
    ctx.scene.leave();
  }
}

// Handle Receipt Generation (Specific Transaction)
async function handleReceiptSpecific(ctx) {
  const userId = ctx.from.id.toString();
  try {
    // Fetch all transactions for the user
    const transactionsSnapshot = await db.collection('transactions').where('userId', '==', userId).orderBy('timestamp', 'desc').get();
    if (transactionsSnapshot.empty) {
      await ctx.reply('❌ You have no transactions to select.');
      return ctx.scene.leave();
    }

    // Create a list of transactions for selection
    const keyboard = transactionsSnapshot.docs.map((doc, index) => [
      Markup.button.callback(`Transaction ${index + 1} - ${doc.data().referenceId}`, `select_tx_${doc.id}`)
    ]);

    // Add a back button
    keyboard.push([Markup.button.callback('🔙 Back', 'receipt_back_options')]);

    await ctx.reply('Please select the transaction for which you want to generate a receipt:', Markup.inlineKeyboard(keyboard, { columns: 1 }));
    ctx.session.transactions = transactionsSnapshot.docs.map(doc => ({ id: doc.id, data: doc.data() }));
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error fetching transactions for specific receipt: ${error.message}`);
    await ctx.reply('⚠️ An error occurred. Please try again later.');
    ctx.scene.leave();
  }
}

// Handle Select Specific Transaction
async function handleSelectTransaction(ctx, transactionId) {
  const userId = ctx.from.id.toString();
  try {
    // Fetch the specific transaction
    const txDoc = await db.collection('transactions').doc(transactionId).get();
    if (!txDoc.exists || txDoc.data().userId !== userId) {
      await ctx.reply('❌ Transaction not found or unauthorized access.');
      return ctx.scene.leave();
    }

    const tx = txDoc.data();

    // Generate PDF receipt for the specific transaction
    const doc = new PDFDocument();
    const stream = doc.pipe(blobStream());

    doc.fontSize(20).text('Transaction Receipt', { align: 'center' });
    doc.moveDown();

    doc.fontSize(12).text(`Reference ID: ${tx.referenceId}`);
    doc.text(`Amount: ${tx.amount} ${tx.asset}`);
    doc.text(`Status: ${tx.status}`);
    doc.text(`Date: ${new Date(tx.timestamp).toLocaleString()}`);
    doc.text(`Chain: ${tx.chain}`);
    doc.moveDown();

    doc.end();

    // Wait for the PDF to be fully generated
    stream.on('finish', async () => {
      const buffer = stream.toBlob('application/pdf');
      const bufferArray = Buffer.from(await buffer.arrayBuffer());

      // Send the PDF to the user
      await ctx.replyWithDocument({ source: bufferArray, filename: `Transaction_Receipt_${tx.referenceId}.pdf` });
      await ctx.reply('✅ Your transaction receipt has been generated and sent.');
      ctx.scene.leave();
    });
  } catch (error) {
    logger.error(`Error generating specific transaction receipt for user ${userId}: ${error.message}`);
    await ctx.reply('⚠️ An error occurred while generating your receipt. Please try again later.');
    ctx.scene.leave();
  }
}

// Handle Base Page Pagination
async function handleBasePage(ctx, pageIndex) {
  if (isNaN(pageIndex) || pageIndex < 0 || pageIndex >= baseContent.length) {
    await ctx.reply('⚠️ Invalid page number.');
    return;
  }
  await sendBaseContent(ctx, pageIndex);
}

// Handle Settings Support
async function handleSettingsSupport(ctx) {
  await ctx.reply('🛠️ *Support Section*\n\nSelect an option below:', Markup.inlineKeyboard([
    [Markup.button.callback('📘 How It Works', 'support_how_it_works')],
    [Markup.button.callback('⚠️ Transaction Not Received', 'support_not_received')],
    [Markup.button.callback('💬 Contact Support', 'support_contact')],
    [Markup.button.callback('🔙 Back to Settings', 'settings_back_main')],
  ]));
}

// =================== Admin Functions ===================

// Handle Admin Send Message
// Already handled with send_message_scene

// Handle Admin Broadcast Message
// Already handled with broadcast_message

// =================== Handle Receipt Generation Callbacks ===================
bot.action('receipt_all', async (ctx) => {
  await handleReceiptAll(ctx);
});

bot.action('receipt_specific', async (ctx) => {
  await handleReceiptSpecific(ctx);
});

// =================== Handle Select Specific Transaction ===================
bot.action(/select_tx_(.+)/, async (ctx) => {
  const transactionId = ctx.match[1];
  await handleSelectTransaction(ctx, transactionId);
});

// =================== Handle "📘 Learn About Base" Button ===================
// Already handled above

// =================== Additional Handler Functions ===================

// Handle Admin Actions (if any additional admin actions are required)
// For now, all admin actions are handled directly in the callback query handler

// =================== Scenes and Middleware Registration ===================
// Already defined above

// =================== Webhook Handlers ===================
// Already handled above

// =================== Telegram Webhook Setup ===================

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

// =================== Express Server ===================
const port = process.env.PORT || 4000;
app.listen(port, () => {
  logger.info(`Webhook server running on port ${port}`);
});
