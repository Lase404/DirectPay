// Import Dependencies
const express = require('express');
const { Telegraf, Markup, Scenes, session } = require('telegraf');
const admin = require('firebase-admin');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const winston = require('winston');
const Bottleneck = require('bottleneck');
require('dotenv').config(); // Ensure to install dotenv and create a .env file

// Logger Setup
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

// Firebase Setup
const serviceAccount = require('./directpay.json'); // Ensure this file is secured on the server
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://directpay9ja.firebaseio.com"
});
const db = admin.firestore();

// Configuration & API Keys
const BOT_TOKEN = process.env.BOT_TOKEN;
const PAYCREST_API_KEY = process.env.PAYCREST_API_KEY; // Client ID
const PAYCREST_CLIENT_SECRET = process.env.PAYCREST_CLIENT_SECRET; // Client Secret
const PAYCREST_RATE_API_URL = process.env.PAYCREST_RATE_API_URL || 'https://api.paycrest.io/v1/rates'; // Paycrest Rate API Endpoint
const PAYCREST_RETURN_ADDRESS = process.env.PAYCREST_RETURN_ADDRESS || "0xYourReturnAddressHere"; // Paycrest Return Address
const PERSONAL_CHAT_ID = process.env.PERSONAL_CHAT_ID;
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => id.trim()) : [];
const MAX_WALLETS = 5;

// Telegram Webhook Configuration
const TELEGRAM_WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/webhook/telegram'; // e.g., '/webhook/telegram'
const WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN; // e.g., 'https://your-domain.com'
const TELEGRAM_WEBHOOK_URL = `${WEBHOOK_DOMAIN}${TELEGRAM_WEBHOOK_PATH}`;

// Blockradar API Keys Mapping
const BLOCKRADAR_API_KEYS = {
  'Base': process.env.BLOCKRADAR_BASE_API_KEY,
  'BNB Smart Chain': process.env.BLOCKRADAR_BNB_API_KEY,
  'Polygon': process.env.BLOCKRADAR_POLYGON_API_KEY,
};

// Supported Assets
const SUPPORTED_ASSETS = ['USDC', 'USDT'];

// Exchange Rates (Dynamic)
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

// Multi-Chain Wallet Configuration with Asset IDs and Blockradar's API
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

// Initialize Express App for Webhooks
const app = express();
app.use(express.json());

// Initialize Telegraf Bot with Session and Stage Middleware
const bot = new Telegraf(BOT_TOKEN);

// Scenes and Middleware Setup
const stage = new Scenes.Stage();
const bankLinkingScene = new Scenes.BaseScene('bank_linking_scene');
const sendMessageScene = new Scenes.BaseScene('send_message_scene');
const receiptGenerationScene = new Scenes.BaseScene('receipt_generation_scene'); // Ensure this scene is defined
stage.register(bankLinkingScene, sendMessageScene, receiptGenerationScene);
bot.use(session());
bot.use(stage.middleware());

// Updated Bank List with Paycrest Institution Codes
const bankList = [
  { name: 'Access Bank', code: '044', aliases: ['access', 'access bank', 'accessb', 'access bank nigeria'], paycrestInstitutionCode: 'ABNGNGLA' },
  // ... (rest of the banks)
  { name: 'Wema Bank', code: '035', aliases: ['wema', 'wema bank', 'wemab', 'wema bank nigeria'], paycrestInstitutionCode: 'WEMANGLA' },
  { name: 'Kuda Microfinance Bank', code: '50211', aliases: ['kuda', 'kuda bank', 'kudab', 'kuda bank nigeria'], paycrestInstitutionCode: 'KUDANGPC' },
  { name: 'OPay', code: '999992', aliases: ['opay', 'opay nigeria'], paycrestInstitutionCode: 'OPAYNGPC' },
  { name: 'PalmPay', code: '999991', aliases: ['palmpay', 'palmpay nigeria'], paycrestInstitutionCode: 'PALMNGPC' },
  { name: 'Paystack-Titan MFB', code: '999992', aliases: ['paystack', 'paystack mfb', 'paystack-titan mfb'], paycrestInstitutionCode: 'PAYTNGPC' },
  { name: 'Moniepoint MFB', code: '999993', aliases: ['moniepoint', 'moniepoint mfb', 'moniepoint nigeria'], paycrestInstitutionCode: 'MONINGPC' },
  { name: 'Safe Haven MFB', code: '999994', aliases: ['safe haven', 'safe haven mfb', 'safe haven nigeria'], paycrestInstitutionCode: 'SAHVNGPC' }
  // Add more banks as needed
];

const PAYSTACK_API_KEY = process.env.PAYSTACK_API_KEY;

// Verify Bank Account with Paycrest
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

// Main Menu Dynamically Updated Based on Wallet and Bank Status
const getMainMenu = (userState) => {
  const walletExists = userState.wallets.length > 0;
  const hasBankLinked = userState.wallets.some(wallet => wallet.bank);

  // Define menu options based on user state
  const menuButtons = [];

  // Step 1: Generate Wallet or View Wallets
  menuButtons.push([
    Markup.button.text(walletExists ? '💼 View Wallets' : '💼 Generate Wallet')
  ]);

  // Step 2: Link Bank (if not linked)
  if (!hasBankLinked) {
    menuButtons.push([
      Markup.button.text('🏦 Link Bank Account')
    ]);
  }

  // Step 3: How to Deposit & Withdraw
  menuButtons.push([
    Markup.button.text('📖 How to Deposit & Withdraw')
  ]);

  // Step 4: Transactions
  menuButtons.push([
    Markup.button.text('💰 Transactions')
  ]);

  // Step 5: Support
  menuButtons.push([
    Markup.button.text('ℹ️ Support'),
    Markup.button.text('📘 Learn About Base')
  ]);

  // Add 'View Current Rates' with refresh option
  menuButtons.push([
    Markup.button.text('📈 View Current Rates')
  ]);

  return Markup.keyboard(menuButtons).resize();
};

// Settings Submenu
const getSettingsMenu = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Generate New Wallet', 'settings_generate_wallet')],
    [Markup.button.callback('✏️ Edit Linked Bank Details', 'settings_edit_bank')],
    [Markup.button.callback('💬 Support', 'settings_support')],
    [Markup.button.callback('🧾 Generate Transaction Receipt', 'settings_generate_receipt')],
    [Markup.button.callback('🔙 Back to Main Menu', 'settings_back_main')],
  ]);

// Admin Menu
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

// Check if User is Admin
const isAdmin = (userId) => ADMIN_IDS.includes(userId.toString());

// Firestore Helper Functions

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

// Greet User with Personalized Message and Step-by-Step Flow
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

  const adminUser = isAdmin(userId);

  // Create a personalized and friendly greeting
  const greeting = `👋 Hello, ${userState.firstName}!\n\nWelcome to **DirectPay**, your gateway to seamless crypto transactions.\n\n💡 **Getting Started**:\n1. *Generate a Wallet*\n2. *Link Your Bank Account*\n3. *Learn How to Deposit & Withdraw*\n\nWe’re here to make your experience smooth and secure. Let’s get started!`;

  if (adminUser) {
    const sentMessage = await ctx.replyWithMarkdown(greeting, Markup.inlineKeyboard([
      [Markup.button.callback('🔧 Admin Panel', 'open_admin_panel')],
    ]));
    ctx.session.adminMessageId = sentMessage.message_id;
  } else {
    await ctx.replyWithMarkdown(greeting, getMainMenu(userState));
  }
}

// Handle /start Command
bot.start(async (ctx) => {
  try {
    await greetUser(ctx);
  } catch (error) {
    logger.error(`Error in /start command: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
  }
});

// Generate Wallet Function
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

// Create Paycrest Order Function
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

// Withdraw from Blockradar Function
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

    // Enter the Bank Linking Scene Immediately
    await ctx.scene.enter('bank_linking_scene');
  } catch (error) {
    logger.error(`Error generating wallet for user ${userId} on ${chain}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ There was an issue generating your wallet. Please try again later.');
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error generating wallet for user ${userId}: ${error.message}`, { parse_mode: 'Markdown' });
  }
});

// =================== Handle "💼 View Wallet" Button ===================
bot.hears('💼 View Wallets', async (ctx) => {
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

    // Add a "New Wallet" button
    message += `*Options:*\n`;
    const inlineKeyboard = Markup.inlineKeyboard([
      [Markup.button.callback('➕ Add New Wallet', 'add_new_wallet')],
      [Markup.button.callback('🔄 Refresh Wallets', 'refresh_wallets')]
    ]);

    await ctx.replyWithMarkdown(message, inlineKeyboard);
  } catch (error) {
    logger.error(`Error handling View Wallets for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while fetching your wallets. Please try again later.');
  }
});

// Handle "➕ Add New Wallet" Button in View Wallets
bot.action('add_new_wallet', async (ctx) => {
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

    // Acknowledge the callback to remove loading state
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error handling Add New Wallet for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while generating your wallet. Please try again later.');
  }
});

// Handle "🔄 Refresh Wallets" Button
bot.action('refresh_wallets', async (ctx) => {
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

    // Add a "New Wallet" button
    message += `*Options:*\n`;
    const inlineKeyboard = Markup.inlineKeyboard([
      [Markup.button.callback('➕ Add New Wallet', 'add_new_wallet')],
      [Markup.button.callback('🔄 Refresh Wallets', 'refresh_wallets')]
    ]);

    // Edit the message to update wallet details
    try {
      await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: inlineKeyboard.reply_markup });
    } catch (error) {
      // If editing fails (e.g., message not found), send a new message
      await ctx.replyWithMarkdown(message, inlineKeyboard);
    }

    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error refreshing wallets for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while refreshing your wallets. Please try again later.');
    ctx.answerCbQuery();
  }
});

// =================== Handle "⚙️ Settings" Button ===================
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

// Handle "✏️ Edit Linked Bank Details" in Settings
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

// Handle "💬 Support" in Settings
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
      Markup.button.callback(`Wallet ${index + 1} - ${wallet.chain}`, `select_wallet_generate_receipt_${index}`)
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
bot.action(/select_wallet_generate_receipt_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);

  if (isNaN(walletIndex)) {
    await ctx.replyWithMarkdown('⚠️ Invalid wallet selection. Please try again.');
    return ctx.answerCbQuery();
  }

  // Implement receipt generation logic here
  // For demonstration, we'll assume a receipt is generated and sent to the user

  try {
    const userState = await getUserState(userId);
    const wallet = userState.wallets[walletIndex];

    if (!wallet) {
      throw new Error('Wallet not found.');
    }

    // Fetch transactions related to this wallet
    const transactionsSnapshot = await db.collection('transactions').where('walletAddress', '==', wallet.address).orderBy('timestamp', 'desc').limit(10).get();

    if (transactionsSnapshot.empty) {
      return ctx.replyWithMarkdown('You have no transactions for this wallet.');
    }

    let receiptMessage = `🧾 *Transaction Receipt for Wallet ${walletIndex + 1} - ${wallet.chain}*\n\n`;
    transactionsSnapshot.forEach((doc) => {
      const tx = doc.data();
      receiptMessage += `*Reference ID:* \`${tx.referenceId || 'N/A'}\`\n`;
      receiptMessage += `*Amount:* ${tx.amount || 'N/A'} ${tx.asset || 'N/A'}\n`;
      receiptMessage += `*Status:* ${tx.status || 'Pending'}\n`;
      receiptMessage += `*Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n`;
      receiptMessage += `*Chain:* ${tx.chain || 'N/A'}\n\n`;
    });

    await ctx.replyWithMarkdown(receiptMessage);
  } catch (error) {
    logger.error(`Error generating receipt for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while generating the receipt. Please try again later.');
  }

  ctx.answerCbQuery();
});

// =================== Enhance Feedback & Status Messages ===================

// Example: Consolidated Status Updates in Bank Linking Scene
bankLinkingScene.enter(async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const walletIndex = ctx.session.walletIndex;

  if (walletIndex === undefined || walletIndex === null || !userState.wallets[walletIndex]) {
    await ctx.replyWithMarkdown('⚠️ No wallet selected for linking. Please generate a wallet first.');
    ctx.scene.leave();
    return;
  }

  await ctx.replyWithMarkdown('🏦 *Link Your Bank Account*\n\nPlease enter your 10-digit bank account number:');
});

bankLinkingScene.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const bankAccountNumber = ctx.message.text.trim();
  const walletIndex = ctx.session.walletIndex;

  // Validate account number (assuming Nigerian banks with 10 digits)
  if (!/^\d{10}$/.test(bankAccountNumber)) {
    return ctx.replyWithMarkdown('❌ Invalid account number. Please enter a valid 10-digit bank account number:');
  }

  // Store the bank account number in session
  ctx.session.bankData = { accountNumber: bankAccountNumber };
  await ctx.replyWithMarkdown('🔍 Verifying your bank account details...');

  try {
    // Assume the user has only one bank-linked wallet for simplicity
    const userState = await getUserState(userId);
    const bankName = 'Access Bank'; // Replace with dynamic selection if needed
    const bankCode = '044'; // Replace with dynamic selection if needed

    // Verify bank account using Paystack (as per the provided code)
    const verification = await verifyBankAccount(bankAccountNumber, bankCode);

    if (verification.status && verification.data) {
      const accountName = verification.data.account_name;

      // Update bankData with bank details
      ctx.session.bankData.bankName = bankName;
      ctx.session.bankData.bankCode = bankCode;
      ctx.session.bankData.accountName = accountName;

      // Update user's bank details in Firestore
      userState.wallets[walletIndex].bank = {
        bankName: bankName,
        bankCode: bankCode,
        accountNumber: bankAccountNumber,
        accountName: accountName,
      };

      // Update User State in Firestore
      await updateUserState(userId, {
        wallets: userState.wallets,
      });

      // Consolidated Status Update
      const confirmationMessage = `✅ *Bank Account Linked Successfully!*\n\n` +
        `*Bank Name:* ${bankName}\n` +
        `*Account Number:* \`${bankAccountNumber}\`\n` +
        `*Account Holder:* ${accountName}\n\n` +
        `📂 *Linked Wallet Details:*\n` +
        `• *Chain:* ${userState.wallets[walletIndex].chain}\n` +
        `• *Address:* \`${userState.wallets[walletIndex].address}\`\n\n` +
        `You can now receive payouts to this bank account.`;

      await ctx.replyWithMarkdown(confirmationMessage, getMainMenu(userState));

      // Log to Admin
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🔗 User ${userId} linked a bank account:\n\n` +
        `*Account Name:* ${accountName}\n` +
        `*Bank Name:* ${bankName}\n` +
        `*Account Number:* ****${bankAccountNumber.slice(-4)}`, { parse_mode: 'Markdown' });
      logger.info(`User ${userId} linked a bank account: ${JSON.stringify(userState.wallets[walletIndex].bank) }`);

      // Acknowledge the Callback to Remove Loading State
      await ctx.answerCbQuery();

      // Leave the scene
      ctx.scene.leave();
    } else {
      throw new Error('Bank account verification failed.');
    }
  } catch (error) {
    logger.error(`Error verifying bank account for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('❌ Failed to verify your bank account. Please ensure your details are correct or try again later.');
    ctx.scene.leave();
  }
});

// =================== Handle "📖 How to Deposit & Withdraw" Button ===================
bot.hears('📖 How to Deposit & Withdraw', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const guideText = `
**💰 How to Deposit & Withdraw**

*Deposit Funds:*
1. **Generate Your Wallet:**
   - Go to "💼 Generate Wallet" to create a wallet on your preferred network (Base, Polygon, BNB Smart Chain).
2. **Obtain Your Wallet Address:**
   - Copy your unique wallet address.
3. **Send Stablecoins:**
   - Transfer USDC or USDT to your wallet address from any compatible exchange or wallet.
4. **Confirmation:**
   - Once your deposit is confirmed on the network, DirectPay will process your funds.

*Withdraw Funds:*
1. **Ensure Bank Account is Linked:**
   - Go to "⚙️ Settings" > "🏦 Link Bank Account" to add your bank details.
2. **Request Withdrawal:**
   - Go to "💰 Transactions" and select the deposit you wish to withdraw.
3. **Processing:**
   - DirectPay will convert your stablecoins to NGN at the current exchange rate.
4. **Receive Funds:**
   - The equivalent amount in NGN will be credited to your linked bank account within 1-3 minutes.

*Estimated Timelines:*
- **Stablecoin Confirmation:** 1-3 minutes
- **Bank Crediting:** Additional few minutes
`;

    await ctx.replyWithMarkdown(guideText);
  } catch (error) {
    logger.error(`Error sending Deposit & Withdraw guide to user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while fetching the guide. Please try again later.');
  }
});

// =================== Enhance Exchange Rates ===================

// Handle "📈 View Current Rates" Button
bot.hears('📈 View Current Rates', async (ctx) => {
  try {
    let message = '*📈 Current Exchange Rates:*\n\n';
    SUPPORTED_ASSETS.forEach(asset => {
      message += `• *${asset}:* ₦${exchangeRates[asset]}\n`;
    });

    const inlineKeyboard = Markup.inlineKeyboard([
      [Markup.button.callback('↻ Refresh Rates', 'refresh_exchange_rates')],
      [Markup.button.callback('🔙 Back to Main Menu', 'back_main_menu')]
    ]);

    await ctx.replyWithMarkdown(message, inlineKeyboard);
  } catch (error) {
    logger.error(`Error displaying exchange rates: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ Unable to fetch exchange rates. Please try again later.');
  }
});

// Handle "↻ Refresh Rates" Button
bot.action('refresh_exchange_rates', async (ctx) => {
  try {
    await fetchExchangeRates();
    let message = '*📈 Current Exchange Rates:*\n\n';
    SUPPORTED_ASSETS.forEach(asset => {
      message += `• *${asset}:* ₦${exchangeRates[asset]}\n`;
    });

    const inlineKeyboard = Markup.inlineKeyboard([
      [Markup.button.callback('↻ Refresh Rates', 'refresh_exchange_rates')],
      [Markup.button.callback('🔙 Back to Main Menu', 'back_main_menu')]
    ]);

    await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: inlineKeyboard.reply_markup });
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error refreshing exchange rates: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ Unable to refresh exchange rates. Please try again later.');
    ctx.answerCbQuery();
  }
});

// Handle "🔙 Back to Main Menu" Button from Exchange Rates
bot.action('back_main_menu', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    await ctx.editMessageText('🏠 *Main Menu*', getMainMenu(userState));
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error returning to main menu: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
    ctx.answerCbQuery();
  }
});

// =================== Handle "📖 How to Deposit & Withdraw" Button ===================
// Already implemented above

// =================== Enhance Feedback & Status Messages ===================

// Consolidated status messages are already implemented in the bankLinkingScene and other areas by editing messages instead of sending multiple messages.

// =================== Handle "ℹ️ Support" Button ===================
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
      message += `*Reference ID:* \`${tx.referenceId || 'N/A'}\`\n`;
      message += `*Amount:* ${tx.amount || 'N/A'} ${tx.asset || 'N/A'}\n`;
      message += `*Status:* ${tx.status || 'Pending'}\n`;
      message += `*Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n`;
      message += `*Chain:* ${tx.chain || 'N/A'}\n\n`;
    });

    await ctx.replyWithMarkdown(message);
  } catch (error) {
    logger.error(`Error fetching transactions for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ Unable to fetch transactions. Please try again later.');
  }
});

// =================== Streamline Admin UX ===================

// Confirmation Prompts and Enhanced Admin Functionality are already integrated below.

// =================== Admin Functions ===================

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

  // Set a timeout to delete the admin panel message after 5 minutes
  setTimeout(() => {
    if (ctx.session.adminMessageId) {
      ctx.deleteMessage(ctx.session.adminMessageId).catch(() => {});
      ctx.session.adminMessageId = null;
    }
  }, 300000); // Delete after 5 minutes
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
      // Handle viewing transactions with Filters and Pagination
      try {
        await ctx.reply('🔍 *Select a filter for transactions:*', Markup.inlineKeyboard([
          [Markup.button.callback('Last 24 Hours', 'admin_view_transactions_24h')],
          [Markup.button.callback('Last 7 Days', 'admin_view_transactions_7d')],
          [Markup.button.callback('All Pending', 'admin_view_transactions_pending')],
          [Markup.button.callback('🔙 Back to Admin Menu', 'admin_back_to_main')]
        ]));
      } catch (error) {
        logger.error(`Error showing transaction filters: ${error.message}`);
        await ctx.answerCbQuery('⚠️ Unable to show transaction filters.', { show_alert: true });
      }
      break;

    case 'admin_view_transactions_24h':
      await viewAdminTransactions(ctx, '24h');
      break;

    case 'admin_view_transactions_7d':
      await viewAdminTransactions(ctx, '7d');
      break;

    case 'admin_view_transactions_pending':
      await viewAdminTransactions(ctx, 'pending');
      break;

    case 'admin_send_message':
      // Handle sending messages
      if (ctx.session.adminMessageId) {
        await ctx.deleteMessage(ctx.session.adminMessageId).catch(() => {});
        ctx.session.adminMessageId = null;
      }
      await ctx.scene.enter('send_message_scene');
      ctx.answerCbQuery();
      break;

    case 'admin_mark_paid':
      // Handle marking transactions as paid with confirmation
      await ctx.replyWithMarkdown('⚠️ *Are you sure you want to mark all pending transactions as Paid? This action is irreversible.*', Markup.inlineKeyboard([
        [Markup.button.callback('Yes, Mark as Paid', 'admin_confirm_mark_paid')],
        [Markup.button.callback('Cancel', 'admin_cancel_mark_paid')]
      ]));
      ctx.answerCbQuery();
      break;

    case 'admin_confirm_mark_paid':
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
              `Thank you for using *DirectPay*! Your funds have been securely transferred to your bank account. If you have any questions or need further assistance, feel free to [contact our support team](https://t.me/maxcswap).`,
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
        await ctx.replyWithMarkdown('⚠️ Error marking transactions as paid. Please try again later.', getAdminMenu());
        ctx.answerCbQuery();
      }
      break;

    case 'admin_cancel_mark_paid':
      await ctx.replyWithMarkdown('🔄 Marking transactions as paid has been canceled.');
      ctx.answerCbQuery();
      break;

    case 'admin_view_users':
      // Handle viewing all users with pagination
      try {
        await ctx.reply('🔍 *Select a filter for users:*', Markup.inlineKeyboard([
          [Markup.button.callback('All Users', 'admin_view_users_all')],
          [Markup.button.callback('Users with Linked Bank', 'admin_view_users_with_bank')],
          [Markup.button.callback('Users without Linked Bank', 'admin_view_users_without_bank')],
          [Markup.button.callback('🔙 Back to Admin Menu', 'admin_back_to_main')]
        ]));
      } catch (error) {
        logger.error(`Error showing user filters: ${error.message}`);
        await ctx.answerCbQuery('⚠️ Unable to show user filters.', { show_alert: true });
      }
      break;

    case 'admin_view_users_all':
      await viewAdminUsers(ctx, 'all');
      break;

    case 'admin_view_users_with_bank':
      await viewAdminUsers(ctx, 'with_bank');
      break;

    case 'admin_view_users_without_bank':
      await viewAdminUsers(ctx, 'without_bank');
      break;

    case 'admin_broadcast_message':
      // Handle broadcasting messages
      await ctx.reply('📢 Please enter the message you want to broadcast to all users. You can also attach an image (receipt) with your message:');
      // Set state to indicate awaiting broadcast message
      await updateUserState(userId, { awaitingBroadcastMessage: true });
      // Delete the admin panel message to keep chat clean
      if (ctx.session.adminMessageId) {
        await ctx.deleteMessage(ctx.session.adminMessageId).catch(() => {});
        ctx.session.adminMessageId = null;
      }
      ctx.answerCbQuery();
      break;

    case 'admin_manage_banks':
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

// Function to View Admin Transactions with Filters
async function viewAdminTransactions(ctx, filter) {
  try {
    let query = db.collection('transactions').orderBy('timestamp', 'desc');

    if (filter === '24h') {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      query = query.where('timestamp', '>=', since.toISOString());
    } else if (filter === '7d') {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      query = query.where('timestamp', '>=', since.toISOString());
    } else if (filter === 'pending') {
      query = query.where('status', '==', 'Pending');
    }

    const transactionsSnapshot = await query.get();

    if (transactionsSnapshot.empty) {
      await ctx.answerCbQuery('No transactions found for the selected filter.', { show_alert: true });
      return;
    }

    let message = `📋 **Transactions (${filter})**:\n\n`;

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
    logger.error(`Error fetching admin transactions: ${error.message}`);
    await ctx.answerCbQuery('⚠️ Unable to fetch transactions.', { show_alert: true });
  }
}

// Function to View Admin Users with Filters
async function viewAdminUsers(ctx, filter) {
  try {
    let query = db.collection('users');

    if (filter === 'with_bank') {
      query = query.where('wallets', 'array-contains', { bank: admin.firestore.FieldValue.arrayUnion() }); // Adjust query as per Firestore's capabilities
      // Firestore doesn't support array-contains for object fields directly
      // Alternative approach needed, such as adding a separate field indicating bank linkage
      // For simplicity, let's assume a field 'hasBankLinked' exists
      query = query.where('hasBankLinked', '==', true);
    } else if (filter === 'without_bank') {
      query = query.where('hasBankLinked', '==', false);
    }

    const usersSnapshot = await query.get();

    if (usersSnapshot.empty) {
      await ctx.answerCbQuery('No users found for the selected filter.', { show_alert: true });
      return;
    }

    let message = `👥 **Users (${filter})**:\n\n`;

    usersSnapshot.forEach((doc) => {
      const user = doc.data();
      message += `*User ID:* ${doc.id}\n`;
      message += `*First Name:* ${user.firstName || 'N/A'}\n`;
      message += `*Number of Wallets:* ${user.wallets.length}\n`;
      message += `*Bank Linked:* ${user.hasBankLinked ? '✅ Yes' : '❌ No'}\n\n`;
    });

    // Add a 'Back' button to return to the admin menu
    const inlineKeyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🔙 Back to Admin Menu', 'admin_back_to_main')]
    ]);

    // Edit the admin panel message
    await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: inlineKeyboard.reply_markup });
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error fetching admin users: ${error.message}`);
    await ctx.answerCbQuery('⚠️ Unable to fetch users.', { show_alert: true });
  }
}

// =================== Handle "📘 Learn About Base" Button ===================
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

// Start the "Learn About Base" Section
bot.hears(/📘\s*Learn About Base/i, async (ctx) => {
  await sendBaseContent(ctx, 0, true);
});

// Function to Send Base Content with Pagination and Inline Updates
async function sendBaseContent(ctx, index, isNew = false) {
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

  // Set a timeout to delete the message after 2 minutes
  setTimeout(() => {
    if (ctx.session.baseMessageId) {
      ctx.deleteMessage(ctx.session.baseMessageId).catch(() => {});
      ctx.session.baseMessageId = null;
    }
  }, 120000); // Delete after 2 minutes
}

// Handle Base Content Pagination
bot.action(/base_page_(\d+)/, async (ctx) => {
  const index = parseInt(ctx.match[1], 10);
  if (isNaN(index) || index < 0 || index >= baseContent.length) {
    return ctx.answerCbQuery('⚠️ Invalid page number.', { show_alert: true });
  }
  await sendBaseContent(ctx, index);
  ctx.answerCbQuery(); // Acknowledge the callback
});

// Exit the "Learn About Base" Section
bot.action('exit_base', async (ctx) => {
  // Delete the message and clear session
  if (ctx.session.baseMessageId) {
    await ctx.deleteMessage(ctx.session.baseMessageId).catch(() => {});
    ctx.session.baseMessageId = null;
  }
  await ctx.replyWithMarkdown('Thank you for learning about Base!');
  ctx.answerCbQuery();
});

// =================== Support Functionality ===================
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

// =================== Learn About Base with Pagination and Inline Updates ===================

// Already implemented above

// =================== Handle "📘 Learn About Base" Button ===================

// Already implemented above

// =================== Handle "ℹ️ Support" Button ===================

// Already implemented above

// =================== Handle "💰 Transactions" Button ===================

// Already implemented above

// =================== Admin Functions Continued ===================

// Function to Send Admin Transactions with Filters
// Already implemented above as viewAdminTransactions

// Function to Send Admin Users with Filters
// Already implemented above as viewAdminUsers

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
        `*Crypto Amount:* ${txData.amount} ${txData.asset}\n` +
        `*Cash Amount:* NGN ${txData.payout}\n` +
        `*Network:* ${txData.chain}\n` +
        `*Date:* ${new Date(txData.timestamp).toLocaleString()}\n\n` +
        `📌 *Transaction Details:*\n` +
        `• *Reference ID:* \`${txData.referenceId || 'N/A'}\`\n` +
        `• *Transaction Hash:* \`${txData.transactionHash}\`\n` +
        `• *Sender Address:* \`${txData.walletAddress}\`\n` +
        `• *Receiver Address:* \`${PAYCREST_RETURN_ADDRESS}\`\n` +
        `• *Company:* *DirectPay*\n\n` +
        `💬 We value your feedback! Please rate your experience with us.`,
        { parse_mode: 'Markdown' }
      );

      // Optionally, edit the pending message to indicate completion
      if (messageId) {
        try {
          await bot.telegram.editMessageText(userId, messageId, null, `🎉 *Funds Credited Successfully!*\n\n` +
            `Your DirectPay order has been completed. Here are the details of your order:\n\n` +
            `*Crypto Amount:* ${txData.amount} ${txData.asset}\n` +
            `*Cash Amount:* NGN ${txData.payout}\n` +
            `*Network:* ${txData.chain}\n` +
            `*Date:* ${new Date(txData.timestamp).toLocaleString()}\n\n` +
            `📌 *Transaction Details:*\n` +
            `• *Reference ID:* \`${txData.referenceId || 'N/A'}\`\n` +
            `• *Transaction Hash:* \`${txData.transactionHash}\`\n` +
            `• *Sender Address:* \`${txData.walletAddress}\`\n` +
            `• *Receiver Address:* \`${PAYCREST_RETURN_ADDRESS}\`\n` +
            `• *Company:* *DirectPay*\n\n` +
            `💬 We value your feedback! Please rate your experience with us.`,
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
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error processing Paycrest webhook for orderId ${orderId}: ${error.message}`, { parse_mode: 'Markdown' });
    }
  } else {
    logger.info(`Unhandled Paycrest event: ${event}`);
    res.status(200).send('OK');
  }
});

// Blockradar Webhook Endpoint
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

      // Send Detailed Pending Message to User
      const pendingMessage = await bot.telegram.sendMessage(userId,
        `🎉 *Deposit Received!*\n\n` +
        `Hello ${userFirstName},\n\n` +
        `We’ve received your deposit of *${amount} ${asset}* on *${chainRaw}*. We’re now verifying the transaction on the **${chainRaw}** network. We’ll notify you once the off-ramp process begins.\n\n` +
        `💰 *Estimated Timelines:*\n• *Stablecoin Confirmation:* 1-3 minutes\n• *Bank Crediting:* Additional few minutes\n\n` +
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
        `*Equivalent Cash Amount:* NGN ${ngnAmount}\n` +
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
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error creating Paycrest order for user ${userId}: ${err.message}`, { parse_mode: 'Markdown' });
        // Update transaction status to 'Failed'
        await transactionRef.update({ status: 'Failed' });
        // Update user's pending message to indicate failure
        const failureMessage = `Hello ${userFirstName},\n\n` +
          `⚠️ *We encountered an issue while processing your deposit.*\n\n` +
          `Please contact our support team for assistance. Error Code: #PAYCREST001`;
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
          `⚠️ *We encountered an issue while processing your withdrawal.*\n\n` +
          `Please contact our support team for assistance. Error Code: #BLOCKRADAR001`;
        await bot.telegram.editMessageText(userId, pendingMessage.message_id, null, failureMessage, { parse_mode: 'Markdown' });
        return res.status(500).send('Blockradar withdrawal error');
      }

      // Store Transaction in Firestore
      await db.collection('transactions').doc(transactionRef.id).update({
        status: 'Pending',
        paycrestOrderId: paycrestOrder.id
      });

      logger.info(`Transaction stored for user ${userId}: Reference ID ${paycrestOrder.id}`);

      // Update User's Pending Message to Final Success Message with consolidated information
      const finalMessage = `🎉 *Funds Credited Successfully!*\n\n` +
        `Hello ${userFirstName},\n\n` +
        `Your DirectPay order has been completed. Here are the details of your order:\n\n` +
        `*Crypto Amount:* ${txData.amount} ${txData.asset}\n` +
        `*Cash Amount:* NGN ${txData.payout}\n` +
        `*Network:* ${txData.chain}\n` +
        `*Date:* ${new Date(txData.timestamp).toLocaleString()}\n\n` +
        `📌 *Transaction Details:*\n` +
        `• *Reference ID:* \`${txData.referenceId || 'N/A'}\`\n` +
        `• *Transaction Hash:* \`${txData.transactionHash}\`\n` +
        `• *Sender Address:* \`${txData.walletAddress}\`\n` +
        `• *Receiver Address:* \`${PAYCREST_RETURN_ADDRESS}\`\n` +
        `• *Company:* *DirectPay*\n\n` +
        `💬 We value your feedback! Please rate your experience with us.`;

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

      res.status(200).send('OK');
    }
  } catch (error) {
    logger.error(`Error processing Blockradar webhook: ${error.message}`);
    res.status(500).send('Error processing webhook');
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error processing Blockradar webhook: ${error.message}`);
  }
});

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

// Start Express Server
const port = process.env.PORT || 4000;
app.listen(port, () => {
  logger.info(`Webhook server running on port ${port}`);
});

// Graceful Shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
