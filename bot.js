// Required Modules
const Web3 = require('web3');
const { Telegraf, Markup, Scenes, session } = require('telegraf');
const axios = require('axios');
const admin = require('firebase-admin');
const express = require('express');
const fs = require('fs');
const path = require('path');
const winston = require('winston');

// Load environment variables
require('dotenv').config();

// Configure Winston Logger
const logger = winston.createLogger({
  level: 'info', // Change to 'debug' for more detailed logs
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'bot.log' })
  ],
});

// Firebase setup
const serviceAccount = require('./directpay.json'); // Ensure this file is secure
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://directpay9ja.firebaseio.com"
});
const db = admin.firestore();

// Config & API Keys
const BOT_TOKEN = process.env.BOT_TOKEN;
const PAYSTACK_API_KEY = process.env.PAYSTACK_API_KEY;
const PERSONAL_CHAT_ID = process.env.PERSONAL_CHAT_ID;
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => id.trim()) : [];
const MAX_WALLETS = 5;

// Multi-Chain Blockradar credentials using BlockRadar
const chains = {
  Base: {
    id: '83eeb82c-bf7b-4e70-bdd0-ab87b4fbcc2d',
    key: 'grD8lJpMPjvjChMo5SnOl0eZmaabikn2z2S2rXKkAxCM1oWsZDMwFQL9LWgrc',
    address: '0x9A52605A21e3bacD791579D980A975b258968041',
    apiUrl: 'https://api.blockradar.co/v1/wallets/83eeb82c-bf7b-4e70-bdd0-ab87b4fbcc2d/addresses',
    supportedAssets: ['USDT', 'USDC'],
    network: 'Base'
  },
  Polygon: {
    id: 'f7d5b102-e94a-493a-8e0c-8da96fe70655',
    key: 'iXV8e72v9QLKcKfI4Nw8SkqKtEoyzAQFCFinIZKwj7pKUtFxaRMjlLCt5p3DZND',
    address: '0x9A52605A21e3bacD791579D980A975b258968041',
    apiUrl: 'https://api.blockradar.co/v1/wallets/f7d5b102-e94a-493a-8e0c-8da96fe70655/addresses',
    supportedAssets: ['USDT', 'USDC'],
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

// Web3 Setup for Base Testnet
const web3 = new Web3('https://sepolia.base.org');

// Initialize Express App
const app = express();
app.use(express.json());

// Initialize Telegraf Bot with session and stage middleware
const bot = new Telegraf(BOT_TOKEN);

// Create a new Stage for admin actions and bank linking using Telegraf Scenes
const stage = new Scenes.Stage();

// Scene for sending messages to users (text and images)
const sendMessageScene = new Scenes.BaseScene('send_message_scene');

sendMessageScene.enter((ctx) => {
  ctx.reply('📩 Please enter the User ID you want to message:');
});

sendMessageScene.on('text', async (ctx) => {
  const input = ctx.message.text.trim();

  if (!ctx.session.userIdToMessage) {
    // Expecting User ID
    if (!/^\d+$/.test(input)) {
      return ctx.reply('❌ Invalid User ID. Please enter a numeric User ID.');
    }
    ctx.session.userIdToMessage = input;
    return ctx.reply('📝 Please enter the message you want to send to the user.');
  } else {
    // Sending text message to user
    const userIdToMessage = ctx.session.userIdToMessage;
    const messageContent = ctx.message.text;

    try {
      await bot.telegram.sendMessage(userIdToMessage, `📩 *Message from Admin:*\n\n${escapeMarkdownV2(messageContent)}`, { parse_mode: 'MarkdownV2' });
      await ctx.reply('✅ Text message sent successfully.');
      logger.info(`Admin sent message to user ${userIdToMessage}: ${messageContent}`);
    } catch (error) {
      logger.error(`Error sending message to user ${userIdToMessage}: ${error.message}`);
      await ctx.reply('⚠️ Error sending message. Please ensure the User ID is correct and the user has not blocked the bot.');
    }

    ctx.scene.leave();
  }
});

sendMessageScene.on('photo', async (ctx) => {
  if (!ctx.session.userIdToMessage) {
    return ctx.reply('❌ Please enter the User ID first.');
  }

  const userIdToMessage = ctx.session.userIdToMessage;
  const photo = ctx.message.photo[ctx.message.photo.length - 1]; // Highest resolution
  const caption = ctx.message.caption || '';

  try {
    await bot.telegram.sendPhoto(userIdToMessage, photo.file_id, {
      caption: `✔️ *Message from Admin:*\n\n${escapeMarkdownV2(caption)}`,
      parse_mode: 'MarkdownV2',
    });
    await ctx.reply('✅ Image sent successfully.');
    logger.info(`Admin sent image to user ${userIdToMessage}. Caption: ${caption}`);
  } catch (error) {
    logger.error(`Error sending image to user ${userIdToMessage}: ${error.message}`);
    await ctx.reply('⚠️ Error sending image. Please ensure the User ID is correct and the user has not blocked the bot.');
  }

  ctx.scene.leave();
});

sendMessageScene.on('message', (ctx) => ctx.reply('❌ Please send text or photo messages only.'));

sendMessageScene.leave((ctx) => {
  delete ctx.session.userIdToMessage;
});

// Bank Linking Scene
const bankLinkingScene = new Scenes.BaseScene('bank_linking_scene');

bankLinkingScene.enter((ctx) => {
  ctx.session.bankData = {};
  // ctx.session.walletIndex is already set before entering the scene
  ctx.reply('🏦 Please enter your bank name (e.g., Access Bank):');
});

bankLinkingScene.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const input = ctx.message.text.trim();

  if (!ctx.session.bankData.bankName) {
    // Process bank name
    const bankNameInput = input.toLowerCase();
    const bank = bankList.find((b) => b.aliases.includes(bankNameInput));

    if (!bank) {
      return ctx.reply('❌ Invalid bank name. Please enter a valid bank name from our supported list.');
    }

    ctx.session.bankData.bankName = bank.name;
    ctx.session.bankData.bankCode = bank.code;
    return ctx.reply('🔢 Please enter your 10-digit bank account number:');
  } else if (!ctx.session.bankData.accountNumber) {
    // Process account number
    if (!/^\d{10}$/.test(input)) {
      return ctx.reply('❌ Invalid account number. Please enter a valid 10-digit account number:');
    }

    ctx.session.bankData.accountNumber = input;

    // Verify Bank Account
    await ctx.reply('🔄 Verifying your bank details...');
    try {
      const verificationResult = await verifyBankAccount(ctx.session.bankData.accountNumber, ctx.session.bankData.bankCode);

      if (!verificationResult || !verificationResult.data) {
        throw new Error('Invalid verification response.');
      }

      const accountName = verificationResult.data.account_name;

      if (!accountName) {
        throw new Error('Unable to retrieve account name.');
      }

      ctx.session.bankData.accountName = accountName;

      // Ask for Confirmation
      await ctx.reply(
        `🏦 *Bank Account Verification*\n\nPlease confirm your bank details:\n` +
        `- *Bank Name:* ${escapeMarkdownV2(ctx.session.bankData.bankName)}\n` +
        `- *Account Number:* ${escapeMarkdownV2(ctx.session.bankData.accountNumber)}\n` +
        `- *Account Holder:* ${escapeMarkdownV2(accountName)}\n\n` +
        `Is this information correct?`,
        Markup.inlineKeyboard([
          Markup.button.callback('✅ Yes, Confirm', 'confirm_bank_yes'),
          Markup.button.callback('❌ No, Edit Details', 'confirm_bank_no'),
        ])
      );
    } catch (error) {
      logger.error(`Error verifying bank account for user ${userId}: ${error.message}`);
      await ctx.reply('❌ Failed to verify bank account. Please try again later.');
      ctx.scene.leave();
    }
  }
});

bankLinkingScene.action('confirm_bank_yes', async (ctx) => {
  const userId = ctx.from.id.toString();
  const bankData = ctx.session.bankData;
  const walletIndex = ctx.session.walletIndex;

  try {
    let userState = await getUserState(userId);

    if (walletIndex === undefined || walletIndex === null || !userState.wallets[walletIndex]) {
      await ctx.reply('⚠️ No wallet selected for linking. Please try again.');
      ctx.scene.leave();
      return;
    }

    // Link Bank to Wallet
    userState.wallets[walletIndex].bank = {
      bankName: bankData.bankName,
      bankCode: bankData.bankCode,
      accountNumber: bankData.accountNumber,
      accountName: bankData.accountName,
    };

    // Update user state in Firestore
    await updateUserState(userId, {
      wallets: userState.wallets,
    });

    // Fetch the current rate for the first supported asset in the wallet
    const firstSupportedAsset = userState.wallets[walletIndex].supportedAssets[0];
    const currentRate = rates[firstSupportedAsset] || 'N/A';

    await ctx.reply(`✅ Your bank account has been linked successfully!\n\n*Current Exchange Rate:* 1 ${escapeMarkdownV2(firstSupportedAsset)} = ₦${escapeMarkdownV2(currentRate)}`, getMainMenu(true));

    // Log to Admin
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🔗 User ${escapeMarkdownV2(userId)} linked a bank account:\n\n` +
      `*Account Name:* ${escapeMarkdownV2(userState.wallets[walletIndex].bank.accountName)}\n` +
      `*Bank Name:* ${escapeMarkdownV2(userState.wallets[walletIndex].bank.bankName)}\n` +
      `*Account Number:* ****${escapeMarkdownV2(userState.wallets[walletIndex].bank.accountNumber.slice(-4))}`, { parse_mode: 'MarkdownV2' });
    logger.info(`User ${userId} linked a bank account: ${JSON.stringify(userState.wallets[walletIndex].bank)}`);
  } catch (error) {
    logger.error(`Error confirming bank account for user ${userId}: ${error.message}`);
    await ctx.reply('⚠️ An unexpected error occurred while processing your request. Please try again later or contact support if the issue persists.');
  }

  // Clean up session variables
  delete ctx.session.walletIndex;
  delete ctx.session.bankData;

  ctx.scene.leave();
});

bankLinkingScene.action('confirm_bank_no', async (ctx) => {
  await ctx.reply('⚠️ Let\'s try again.');
  // Reset bank data and restart the scene
  ctx.session.bankData = {};
  ctx.scene.reenter(); // Restart the scene
});

bankLinkingScene.leave((ctx) => {
  delete ctx.session.walletIndex;
  delete ctx.session.bankData;
});

stage.register(sendMessageScene);
stage.register(bankLinkingScene);

// Use session middleware
bot.use(session());

// Use the stage middleware
bot.use(stage.middleware());

// Utility Functions

// Function to escape MarkdownV2 special characters
function escapeMarkdownV2(text) {
  if (!text) return '';
  return text.replace(/([_*[\]()~`>#+-=|{}.!])/g, '\\$1');
}

// Rates dynamically fetched from CoinGecko
let rates = { USDC: 0, USDT: 0, ETH: 0 };

// Function to fetch rates from CoinGecko
async function fetchRates() {
  try {
    const response = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
      params: {
        ids: 'usd-coin,tether,ethereum', // CoinGecko IDs for USDC, USDT, ETH
        vs_currencies: 'ngn',
      },
    });

    const data = response.data;

    const fetchedRates = {
      USDC: data['usd-coin']?.ngn || 0,
      USDT: data['tether']?.ngn || 0,
      ETH: data['ethereum']?.ngn || 0,
    };

    // Log the fetched rates
    logger.info(`Fetched rates from CoinGecko: ${JSON.stringify(fetchedRates)}`);

    return fetchedRates;
  } catch (error) {
    logger.error(`Error fetching rates from CoinGecko: ${error.message}`);
    throw new Error('Failed to fetch rates from CoinGecko.');
  }
}

// Initialize rates cache and set interval for updates
const PERSONAL_CHAT_ID_ENV = process.env.PERSONAL_CHAT_ID; // To prevent undefined variable

const updateRates = async () => {
  try {
    const fetchedRates = await fetchRates();
    rates = fetchedRates;
    logger.info('Exchange rates updated successfully.');
  } catch (error) {
    logger.error(`Failed to update exchange rates: ${error.message}`);
    // Optionally, notify admin about the failure
    if (PERSONAL_CHAT_ID_ENV) {
      try {
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID_ENV, `❗️ Failed to update exchange rates: ${escapeMarkdownV2(error.message)}`);
      } catch (sendError) {
        logger.error(`Failed to notify admin about rate update failure: ${sendError.message}`);
      }
    }
  }
};

// Initial rates fetch
updateRates();

// Schedule rates update every 10 minutes
setInterval(updateRates, 10 * 60 * 1000); // 10 minutes in milliseconds

// Bank List with Names, Codes, and Aliases
const bankList = [
  { name: 'Access Bank', code: '044', aliases: ['access', 'access bank', 'accessb', 'access bank nigeria'] },
  { name: 'GTBank', code: '058', aliases: ['gtbank', 'gt bank', 'gtb', 'guaranty trust bank'] },
  { name: 'Zenith Bank', code: '057', aliases: ['zenith', 'zenith bank', 'zenithb', 'zenith bank nigeria'] },
  { name: 'First Bank', code: '011', aliases: ['first bank', 'firstbank', 'fbank', 'first bank nigeria'] },
  { name: 'UBA', code: '033', aliases: ['uba', 'united bank for africa', 'uba nigeria'] },
  { name: 'Polaris Bank', code: '076', aliases: ['polaris', 'polaris bank', 'polarisb', 'polaris bank nigeria'] },
  { name: 'Fidelity Bank', code: '070', aliases: ['fidelity', 'fidelity bank', 'fidelityb', 'fidelity bank nigeria'] },
  { name: 'Ecobank', code: '050', aliases: ['ecobank', 'ecobank nigeria', 'eco bank'] },
  { name: 'Union Bank', code: '032', aliases: ['union', 'union bank', 'unionb', 'union bank nigeria'] },
  { name: 'Stanbic IBTC Bank', code: '221', aliases: ['stanbic', 'stanbic ibtc', 'stanbic bank', 'stanbic ibtc nigeria'] },
  { name: 'Standard Chartered Bank', code: '068', aliases: ['standard chartered', 'standard bank', 'standard chartered nigeria'] },
  { name: 'Sterling Bank', code: '232', aliases: ['sterling', 'sterling bank', 'sterlingb', 'sterling bank nigeria'] },
  { name: 'Wema Bank', code: '035', aliases: ['wema', 'wema bank', 'wemab', 'wema bank nigeria'] },
  { name: 'Keystone Bank', code: '082', aliases: ['keystone', 'keystone bank', 'keystoneb', 'keystone bank nigeria'] },
  { name: 'Unity Bank', code: '215', aliases: ['unity', 'unity bank', 'unityb', 'unity bank nigeria'] },
  { name: 'Heritage Bank', code: '030', aliases: ['heritage', 'heritage bank', 'heritageb', 'heritage bank nigeria'] },
  { name: 'FCMB', code: '214', aliases: ['fcmb', 'first city monument bank', 'fcmb nigeria'] },
  { name: 'Jaiz Bank', code: '301', aliases: ['jaiz', 'jaiz bank', 'jaizb', 'jaiz bank nigeria'] },
  { name: 'Parallex Bank', code: '104', aliases: ['parallex', 'parallex bank', 'parallexb', 'parallex bank nigeria'] },
  { name: 'Kuda Bank', code: '50211', aliases: ['kuda', 'kuda bank', 'kudab', 'kuda bank nigeria'] },
  { name: 'Providus Bank', code: '101', aliases: ['providus', 'providus bank', 'providusb', 'providus bank nigeria'] },
  { name: 'ALAT by WEMA', code: '035A', aliases: ['alat', 'alat by wema', 'alat nigeria'] },
  { name: 'PalmPay', code: '999991', aliases: ['palmpay', 'palmpay nigeria'] },
  { name: 'Paycom', code: '999992', aliases: ['paycom', 'paycom nigeria'] }
];

// Verify Bank Account with Paystack
async function verifyBankAccount(accountNumber, bankCode) {
  try {
    const response = await axios.get(`https://api.paystack.co/bank/resolve`, {
      params: { account_number: accountNumber, bank_code: bankCode },
      headers: { Authorization: `Bearer ${PAYSTACK_API_KEY}` },
    });
    return response.data;
  } catch (error) {
    logger.error(`Error verifying bank account (${accountNumber}, ${bankCode}): ${error.message}`);
    throw new Error('Failed to verify bank account. Please try again later.');
  }
}

// Calculate Payout Based on Asset Type
function calculatePayout(asset, amount) {
  if (!rates[asset]) {
    throw new Error(`Unsupported or unavailable asset type: ${asset}`);
  }
  return (amount * rates[asset]).toFixed(2);
}

// Generate a Unique Reference ID for Transactions
function generateReferenceId() {
  return 'REF-' + Math.random().toString(36).substr(2, 9).toUpperCase();
}

// Main Menu Dynamically Updated Based on Wallet Status
const getMainMenu = (walletExists) =>
  Markup.keyboard([
    [walletExists ? '💼 View Wallet' : '💼 Generate Wallet', '🏦 Link Bank Account'],
    ['💰 Transactions', 'ℹ️ Support', '📘 Learn About Base']
    // Removed '/rates' from the main menu
  ]).resize();

// Admin Menu
const getAdminMenu = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('📋 View All Transactions', 'admin_view_transactions')],
    [Markup.button.callback('📩 Send Message to User', 'admin_send_message')],
    [Markup.button.callback('✅ Mark Transactions as Paid', 'admin_mark_paid')],
    [Markup.button.callback('👥 View All Users', 'admin_view_users')],
    [Markup.button.callback('📢 Broadcast Message', 'admin_broadcast_message')],
    [Markup.button.callback('🏦 Manage Banks', 'admin_manage_banks')],
    [Markup.button.callback('🔙 Back to Main Menu', 'admin_back_to_main')],
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
        wallets: [],
        walletAddresses: [],
        bankDetails: null,
        hasReceivedDeposit: false,
        awaitingBroadcastMessage: false, // For admin broadcast
      });
      return {
        wallets: [],
        walletAddresses: [],
        bankDetails: null,
        hasReceivedDeposit: false,
        awaitingBroadcastMessage: false,
      };
    } else {
      const data = userDoc.data();
      // Ensure all properties are defined, else set default values
      return {
        wallets: data.wallets || [],
        walletAddresses: data.walletAddresses || [],
        bankDetails: data.bankDetails || null,
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

// Greet User
async function greetUser(ctx) {
  const userId = ctx.from.id.toString();
  let userState;
  try {
    userState = await getUserState(userId);
  } catch (error) {
    logger.error(`Error fetching user state for ${userId}: ${error.message}`);
    await ctx.reply('⚠️ An error occurred. Please try again later.');
    return;
  }

  const walletExists = userState.wallets.length > 0;
  const adminUser = isAdmin(userId);

  const greeting = walletExists
    ? `👋 Hello, ${escapeMarkdownV2(ctx.from.first_name)}!\n\nWelcome back to *DirectPay*, your gateway to seamless crypto transactions.\n\n💡 *Quick Start Guide:*\n1. **Add Your Bank Account**\n2. **Access Your Dedicated Wallet Address**\n3. **Send Stablecoins and Receive Cash Instantly**\n\nWe offer competitive rates and real-time updates to keep you informed. Your funds are secure, and you'll have cash in your account promptly!\n\nLet's get started!`
    : `👋 Welcome, ${escapeMarkdownV2(ctx.from.first_name)}!\n\nThank you for choosing *DirectPay*. Let's embark on your crypto journey together. Use the menu below to get started.`;

  if (adminUser) {
    const sentMessage = await ctx.reply(greeting, Markup.inlineKeyboard([
      [Markup.button.callback('🔧 Admin Panel', 'open_admin_panel')],
    ]));
    ctx.session.welcomeMessageId = sentMessage.message_id;
  } else {
    await ctx.reply(greeting, getMainMenu(walletExists));
  }
}

// Handle /start Command
bot.start(async (ctx) => {
  try {
    await greetUser(ctx);
  } catch (error) {
    logger.error(`Error in /start command: ${error.message}`);
    await ctx.reply('⚠️ An error occurred. Please try again later.');
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
    return response.data.data.address;
  } catch (error) {
    logger.error(`Error generating wallet for ${chain}: ${error.response ? error.response.data.message : error.message}`);
    throw new Error(`Error generating wallet for ${chain}: ${error.response ? error.response.data.message : error.message}`);
  }
}

// Wallet Generation Handler
bot.action(/generate_wallet_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const selectedChainKey = ctx.match[1]; // 'Base', 'Polygon', 'BNB Smart Chain'

  // Validate selected chain
  if (!chains[selectedChainKey]) {
    await ctx.reply('⚠️ Invalid network selection. Please try again.');
    return ctx.answerCbQuery(); // Acknowledge the callback to remove loading state
  }

  const chain = selectedChainKey;

  // Acknowledge the callback to remove loading state
  await ctx.answerCbQuery();

  // Inform user that wallet generation has started
  const generatingMessage = await ctx.reply('🔄 Generating Wallet for *' + escapeMarkdownV2(chain) + '*... Please wait a moment.', { parse_mode: 'MarkdownV2' });

  try {
    const walletAddress = await generateWallet(chain);

    // Fetch updated user state
    const userState = await getUserState(userId);

    // Add the new wallet to user state
    userState.wallets.push({
      address: walletAddress || 'N/A',
      chain: chain || 'N/A',
      supportedAssets: chains[chain].supportedAssets ? [...chains[chain].supportedAssets] : [],
      bank: null
    });

    // Also, add the wallet address to walletAddresses array
    const updatedWalletAddresses = userState.walletAddresses || [];
    updatedWalletAddresses.push(walletAddress);

    // Update user state in Firestore
    await updateUserState(userId, {
      wallets: userState.wallets,
      walletAddresses: updatedWalletAddresses,
    });

    // Update Menu
    await ctx.reply(`✅ Success! Your new wallet has been generated on *${escapeMarkdownV2(chain)}*:\n\n\`${escapeMarkdownV2(walletAddress)}\`\n\n**Supported Assets:** ${chains[chain].supportedAssets.join(', ')}`, { parse_mode: 'MarkdownV2', ...getMainMenu(true) });

    // Prompt to Link Bank Account
    await ctx.reply('Please link a bank account to receive your payouts.', Markup.keyboard(['🏦 Link Bank Account']).resize());

    // Delete the generating message
    await ctx.deleteMessage(generatingMessage.message_id);

    // Log Wallet Generation
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `💼 Wallet generated for user ${escapeMarkdownV2(userId)} on ${escapeMarkdownV2(chain)}: ${escapeMarkdownV2(walletAddress)}`);
    logger.info(`Wallet generated for user ${userId} on ${chain}: ${walletAddress}`);
  } catch (error) {
    logger.error(`Error generating wallet for user ${userId} on ${chain}: ${error.message}`);
    await ctx.reply('⚠️ There was an issue generating your wallet. Please try again later.');
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error generating wallet for user ${escapeMarkdownV2(userId)}: ${error.message}`);
  }
});

// Generate Wallet Button Handler
bot.hears('💼 Generate Wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  let userState;
  try {
    userState = await getUserState(userId);
  } catch (error) {
    logger.error(`Error fetching user state for ${userId}: ${error.message}`);
    await ctx.reply('⚠️ An error occurred. Please try again later.');
    return;
  }

  if (userState.wallets.length >= MAX_WALLETS) {
    return ctx.reply(`⚠️ You cannot generate more than ${MAX_WALLETS} wallets.`);
  }

  // Prompt user to select a network
  await ctx.reply('Please choose the network you want to generate a wallet for:', Markup.inlineKeyboard([
    [Markup.button.callback('Base', 'generate_wallet_Base')],
    [Markup.button.callback('Polygon', 'generate_wallet_Polygon')],
    [Markup.button.callback('BNB Smart Chain', 'generate_wallet_BNB Smart Chain')],
  ]));
});

// View Wallet
bot.hears(/💼\s*View Wallet/i, async (ctx) => {
  const userId = ctx.from.id.toString();
  let userState;
  try {
    userState = await getUserState(userId);
  } catch (error) {
    logger.error(`Error fetching user state for ${userId}: ${error.message}`);
    await ctx.reply('⚠️ An error occurred. Please try again later.');
    return;
  }

  if (!userState.wallets || userState.wallets.length === 0) {
    return ctx.reply('You have no wallets. Generate a new wallet below.', getMainMenu(false));
  }

  // Display Wallets with Bank Details
  let walletMessage = '💼 *Your Wallets*:\n\n';
  userState.wallets.forEach((wallet, index) => {
    // Escape '#' by prefixing it with a backslash
    walletMessage += `\\#${index + 1} Wallet Address: \`${escapeMarkdownV2(wallet.address || 'N/A')}\`\n`;
    walletMessage += `🔗 Linked Bank: ${wallet.bank ? `Yes - *${escapeMarkdownV2(wallet.bank.bankName)}*` : 'No'}\n`;
    walletMessage += `🌐 Chain: ${escapeMarkdownV2(wallet.chain || 'N/A')}\n`;
    walletMessage += `💱 Supported Assets: ${escapeMarkdownV2(wallet.supportedAssets?.join(', ') || 'N/A')}\n\n`;
    
    if (wallet.bank) {
      walletMessage += `   • *Bank Name:* ${escapeMarkdownV2(wallet.bank.bankName)}\n`;
      walletMessage += `   • *Account Name:* ${escapeMarkdownV2(wallet.bank.accountName)}\n`;
      walletMessage += `   • *Account Number:* ****${escapeMarkdownV2(wallet.bank.accountNumber.slice(-4))}\n\n`;
    }
  });

  await ctx.reply(walletMessage, { parse_mode: 'MarkdownV2' });

  // Determine if user can create a new wallet
  const canCreateNewWallet = userState.wallets.length > 0 && userState.wallets[0].bank;

  await ctx.reply('What would you like to do next?', Markup.inlineKeyboard([
    canCreateNewWallet
      ? [Markup.button.callback('➕ Create New Wallet', 'create_new_wallet')]
      : [Markup.button.callback('🔗 Link Bank to Create New Wallet', 'link_bank_to_create_wallet')]
  ]));
});

// Create New Wallet (From View Wallets)
bot.action('create_new_wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  let userState;
  try {
    userState = await getUserState(userId);
  } catch (error) {
    logger.error(`Error fetching user state for ${userId}: ${error.message}`);
    await ctx.reply('⚠️ An error occurred. Please try again later.');
    return;
  }

  if (!userState.wallets[0].bank) {
    return ctx.reply('⚠️ You must link a bank to your first wallet before creating a new one.');
  }

  if (userState.wallets.length >= MAX_WALLETS) {
    return ctx.reply(`⚠️ You cannot generate more than ${MAX_WALLETS} wallets.`);
  }

  // Prompt user to select a network for the new wallet
  await ctx.reply('Please choose the network you want to generate a new wallet for:', Markup.inlineKeyboard([
    [Markup.button.callback('Base', 'generate_wallet_Base')],
    [Markup.button.callback('Polygon', 'generate_wallet_Polygon')],
    [Markup.button.callback('BNB Smart Chain', 'generate_wallet_BNB Smart Chain')],
  ]));
});

// Link Bank to Create New Wallet (From View Wallets)
bot.action('link_bank_to_create_wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    let userState = await getUserState(userId);

    // Check if user can create a new wallet after linking
    if (userState.wallets.length >= MAX_WALLETS) {
      return ctx.reply(`⚠️ You cannot generate more than ${MAX_WALLETS} wallets.`);
    }

    // Find the first wallet without a linked bank
    const walletIndex = userState.wallets.findIndex((wallet) => !wallet.bank);

    if (walletIndex === -1) {
      return ctx.reply('All your wallets already have a linked bank account.');
    }

    // Store the wallet index in session
    ctx.session.walletIndex = walletIndex;

    ctx.scene.enter('bank_linking_scene');
  } catch (error) {
    logger.error(`Error initiating bank linking for user ${userId}: ${error.message}`);
    await ctx.reply('⚠️ An error occurred. Please try again later.');
  }
});

// Learn About Base with Pagination and Inline Updates
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

// Start the "Learn About Base" section
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
    const sentMessage = await ctx.replyWithMarkdownV2(`*${escapeMarkdownV2(content.title)}*\n\n${escapeMarkdownV2(content.text)}`, inlineKeyboard);
    // Store the message ID in session
    ctx.session.baseMessageId = sentMessage.message_id;
  } else {
    try {
      await ctx.editMessageText(`*${escapeMarkdownV2(content.title)}*\n\n${escapeMarkdownV2(content.text)}`, {
        parse_mode: 'MarkdownV2',
        reply_markup: inlineKeyboard.reply_markup,
      });
    } catch (error) {
      // If editing message fails, send a new message and update session
      const sentMessage = await ctx.replyWithMarkdownV2(`*${escapeMarkdownV2(content.title)}*\n\n${escapeMarkdownV2(content.text)}`, inlineKeyboard);
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

// Exit the "Learn About Base" section
bot.action('exit_base', async (ctx) => {
  // Delete the message and clear session
  if (ctx.session.baseMessageId) {
    await ctx.deleteMessage(ctx.session.baseMessageId).catch(() => {});
    ctx.session.baseMessageId = null;
  }
  await ctx.reply('Thank you for learning about Base!');
  ctx.answerCbQuery();
});

// Support Functionality
bot.hears(/ℹ️\s*Support/i, async (ctx) => {
  await ctx.reply('How can we assist you today?', Markup.inlineKeyboard([
    [Markup.button.callback('❓ How It Works', 'support_how_it_works')],
    [Markup.button.callback('⚠️ Transaction Not Received', 'support_not_received')],
    [Markup.button.callback('💬 Contact Support', 'support_contact')],
  ]));
});

// Support Actions
bot.action('support_how_it_works', async (ctx) => {
  await ctx.reply('DirectPay allows you to receive crypto payments directly into your bank account seamlessly. Generate a wallet, link your bank, and start receiving payments.');
});

bot.action('support_not_received', async (ctx) => {
  await ctx.reply('If you haven’t received your transaction, please ensure that you have linked your bank account. If the issue persists, contact support.');
});

bot.action('support_contact', async (ctx) => {
  await ctx.reply('You can contact our support representative at @maxcswap.');
});

// View Transactions for Users
bot.hears(/💰\s*Transactions/i, async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const transactionsSnapshot = await db.collection('transactions').where('userId', '==', userId).orderBy('timestamp', 'desc').get();

    if (transactionsSnapshot.empty) {
      return ctx.reply('You have no transactions at the moment.');
    }

    let message = '💰 *Your Transactions*:\n\n';

    transactionsSnapshot.forEach((doc) => {
      const tx = doc.data();
      message += `*Reference ID:* \`${escapeMarkdownV2(tx.referenceId || 'N/A')}\`\n`;
      message += `*Amount:* ${escapeMarkdownV2(tx.amount || 'N/A')} ${escapeMarkdownV2(tx.asset || 'N/A')}\n`;
      message += `*Status:* ${escapeMarkdownV2(tx.status || 'Pending')}\n`;
      message += `*Date:* ${tx.timestamp ? escapeMarkdownV2(new Date(tx.timestamp).toLocaleString()) : 'N/A'}\n`;
      message += `*Chain:* ${escapeMarkdownV2(tx.chain || 'N/A')}\n\n`;
    });

    await ctx.replyWithMarkdownV2(message);
  } catch (error) {
    logger.error(`Error fetching transactions for user ${userId}: ${error.message}`);
    await ctx.reply('⚠️ Unable to fetch transactions. Please try again later.');
  }
});

// Admin Functions

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
  ctx.answerCbQuery(); // Acknowledge the callback

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

  if (action === 'view_transactions') {
    // Fetch and display all transactions
    try {
      const transactionsSnapshot = await db.collection('transactions').orderBy('timestamp', 'desc').limit(10).get();

      if (transactionsSnapshot.empty) {
        await ctx.answerCbQuery('No transactions found.', { show_alert: true });
        return;
      }

      let message = '📋 **Recent Transactions**:\n\n';

      transactionsSnapshot.forEach((doc) => {
        const tx = doc.data();
        message += `*User ID:* ${escapeMarkdownV2(tx.userId || 'N/A')}\n`;
        message += `*Reference ID:* \`${escapeMarkdownV2(tx.referenceId || 'N/A')}\`\n`;
        message += `*Amount:* ${escapeMarkdownV2(tx.amount || 'N/A')} ${escapeMarkdownV2(tx.asset || 'N/A')}\n`;
        message += `*Status:* ${escapeMarkdownV2(tx.status || 'Pending')}\n`;
        message += `*Chain:* ${escapeMarkdownV2(tx.chain || 'N/A')}\n`;
        message += `*Date:* ${tx.timestamp ? escapeMarkdownV2(new Date(tx.timestamp).toLocaleString()) : 'N/A'}\n\n`;
      });

      // Add a 'Back' button to return to the admin menu
      const inlineKeyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Back to Admin Menu', 'admin_back_to_main')]
      ]);

      // Edit the admin panel message
      await ctx.editMessageText(message, { parse_mode: 'MarkdownV2', reply_markup: inlineKeyboard.reply_markup });
      ctx.answerCbQuery();
    } catch (error) {
      logger.error(`Error fetching all transactions: ${error.message}`);
      await ctx.answerCbQuery('⚠️ Unable to fetch transactions.', { show_alert: true });
    }
  } else if (action === 'send_message') {
    await ctx.answerCbQuery();
    // Since we cannot handle sending messages within edited messages, we need to delete the admin panel message and start a new conversation
    if (ctx.session.adminMessageId) {
      await ctx.deleteMessage(ctx.session.adminMessageId).catch(() => {});
      ctx.session.adminMessageId = null;
    }
    await ctx.scene.enter('send_message_scene');
  } else if (action === 'mark_paid') {
    // Functionality to mark transactions as paid
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
        const data = transaction.data();
        try {
          await bot.telegram.sendMessage(
            data.userId,
            `🎉 *Transaction Successful!*\n\n` +
            `*Reference ID:* \`${escapeMarkdownV2(data.referenceId || 'N/A')}\`\n` +
            `*Amount Paid:* ${escapeMarkdownV2(data.amount)} ${escapeMarkdownV2(data.asset)}\n` +
            `*Bank:* ${escapeMarkdownV2(data.bankDetails.bankName)}\n` +
            `*Account Name:* ${escapeMarkdownV2(data.bankDetails.accountName)}\n` +
            `*Account Number:* ****${escapeMarkdownV2(data.bankDetails.accountNumber.slice(-4))}\n` +
            `*Payout (NGN):* ₦${escapeMarkdownV2(data.payout)}\n\n` +
            `🔹 *Chain:* ${escapeMarkdownV2(data.chain)}\n` +
            `🔹 *Date:* ${escapeMarkdownV2(new Date(data.timestamp).toLocaleString())}\n\n` +
            `Thank you for using *DirectPay*! Your funds have been securely transferred to your bank account. If you have any questions or need further assistance, feel free to [contact our support team](https://t.me/maxcswap).`,
            { parse_mode: 'MarkdownV2' }
          );
          logger.info(`Notified user ${data.userId} about paid transaction ${data.referenceId}`);
        } catch (error) {
          logger.error(`Error notifying user ${data.userId}: ${error.message}`);
        }
      });

      // Edit the admin panel message to confirm
      await ctx.editMessageText('✅ All pending transactions have been marked as paid.', { reply_markup: getAdminMenu() });
      ctx.answerCbQuery();
    } catch (error) {
      logger.error(`Error marking transactions as paid: ${error.message}`);
      await ctx.answerCbQuery('⚠️ Error marking transactions as paid. Please try again later.', { show_alert: true });
    }
  } else if (action === 'view_users') {
    // Fetch and display all users
    try {
      const usersSnapshot = await db.collection('users').get();

      if (usersSnapshot.empty) {
        await ctx.answerCbQuery('No users found.', { show_alert: true });
        return;
      }

      let message = '👥 **All Users**:\n\n';

      usersSnapshot.forEach((doc) => {
        const user = doc.data();
        message += `*User ID:* ${escapeMarkdownV2(doc.id)}\n`;
        message += `*Number of Wallets:* ${escapeMarkdownV2(user.wallets.length.toString())}\n`;
        message += `*Bank Linked:* ${escapeMarkdownV2(user.wallets.some(wallet => wallet.bank) ? 'Yes' : 'No')}\n\n`;
      });

      // Add a 'Back' button to return to the admin menu
      const inlineKeyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Back to Admin Menu', 'admin_back_to_main')]
      ]);

      // Edit the admin panel message
      await ctx.editMessageText(message, { parse_mode: 'MarkdownV2', reply_markup: inlineKeyboard.reply_markup });
      ctx.answerCbQuery();
    } catch (error) {
      logger.error(`Error fetching all users: ${error.message}`);
      await ctx.answerCbQuery('⚠️ Unable to fetch users.', { show_alert: true });
    }
  } else if (action === 'broadcast_message') {
    await ctx.answerCbQuery();
    await ctx.reply('📢 Please enter the message you want to broadcast to all users:');
    // Set state to indicate awaiting broadcast message
    await updateUserState(userId, { awaitingBroadcastMessage: true });
    // Delete the admin panel message to keep chat clean
    if (ctx.session.adminMessageId) {
      await ctx.deleteMessage(ctx.session.adminMessageId).catch(() => {});
      ctx.session.adminMessageId = null;
    }
  } else if (action === 'manage_banks') {
    // Implement bank management functionalities here
    await ctx.answerCbQuery();
    await ctx.editMessageText('🏦 **Bank Management**\n\nComing Soon!', { parse_mode: 'MarkdownV2', reply_markup: getAdminMenu().reply_markup });
  } else if (action === 'back_to_main') {
    // Return to the main menu
    await ctx.answerCbQuery();
    await greetUser(ctx);
    // Delete the admin panel message
    if (ctx.session.adminMessageId) {
      await ctx.deleteMessage(ctx.session.adminMessageId).catch(() => {});
      ctx.session.adminMessageId = null;
    }
  } else {
    await ctx.answerCbQuery('⚠️ Unknown action. Please select an option from the menu.', { show_alert: true });
  }
});

// Handle Broadcast Message Input
bot.on('text', async (ctx, next) => {
  const userId = ctx.from.id.toString();
  let userState;
  try {
    userState = await getUserState(userId);
  } catch (error) {
    logger.error(`Error fetching user state for ${userId}: ${error.message}`);
    await ctx.reply('⚠️ An error occurred. Please try again later.');
    return;
  }

  if (userState.awaitingBroadcastMessage) {
    const broadcastMessage = ctx.message.text.trim();
    if (!broadcastMessage) {
      return ctx.reply('❌ Message content cannot be empty. Please enter a valid message:');
    }

    try {
      const usersSnapshot = await db.collection('users').get();
      if (usersSnapshot.empty) {
        await ctx.reply('No users to broadcast to.', getAdminMenu());
        await updateUserState(userId, { awaitingBroadcastMessage: false });
        return;
      }

      let successCount = 0;
      let failureCount = 0;

      for (const doc of usersSnapshot.docs) {
        const targetUserId = doc.id;
        try {
          await bot.telegram.sendMessage(targetUserId, `📢 *Broadcast Message:*\n\n${escapeMarkdownV2(broadcastMessage)}`, { parse_mode: 'MarkdownV2' });
          successCount++;
        } catch (error) {
          logger.error(`Error sending broadcast to user ${targetUserId}: ${error.message}`);
          failureCount++;
        }
      }

      await ctx.reply(`✅ Broadcast completed.\n\n📬 Successful: ${successCount}\n❌ Failed: ${failureCount}`, getAdminMenu());
      logger.info(`Admin ${userId} broadcasted message. Success: ${successCount}, Failed: ${failureCount}`);
    } catch (error) {
      logger.error(`Error broadcasting message from admin ${userId}: ${error.message}`);
      await ctx.reply('⚠️ Error broadcasting message. Please try again later.', getAdminMenu());
    }

    // Reset broadcast message state
    await updateUserState(userId, { awaitingBroadcastMessage: false });
  }

  await next(); // Pass control to the next handler
});

// Webhook Handler for Deposits
app.post('/webhook/blockradar', async (req, res) => {
  try {
    const event = req.body;
    logger.info(`Received webhook: ${JSON.stringify(event)}`);
    fs.appendFileSync(path.join(__dirname, 'webhook_logs.txt'), `${new Date().toISOString()} - ${JSON.stringify(event, null, 2)}\n`);

    // Extract common event data
    const eventType = event.event || 'Unknown Event';
    const walletAddress = event.data?.recipientAddress || 'N/A';
    const amount = event.data?.amount || 'N/A';
    const asset = event.data?.asset?.symbol || 'N/A';
    const transactionHash = event.data?.hash || 'N/A';
    const chain = event.data?.blockchain?.name || 'N/A';

    if (eventType === 'deposit.success') {
      if (walletAddress === 'N/A') {
        logger.error('Webhook missing wallet address.');
        return res.status(400).send('Missing wallet address.');
      }

      // Find User by Wallet Address
      const usersSnapshot = await db.collection('users').where('walletAddresses', 'array-contains', walletAddress).get();
      if (usersSnapshot.empty) {
        logger.warn(`No user found for wallet ${walletAddress}`);
        // Notify admin about the unmatched wallet
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ No user found for wallet address: \`${escapeMarkdownV2(walletAddress)}\``);
        return res.status(200).send('OK');
      }

      const userDoc = usersSnapshot.docs[0];
      const userId = userDoc.id;
      const userState = userDoc.data();

      const wallet = userState.wallets.find((w) => w.address === walletAddress);

      // Check if Wallet has Linked Bank
      if (!wallet || !wallet.bank) {
        await bot.telegram.sendMessage(userId, `💰 Deposit Received: ${escapeMarkdownV2(amount)} ${escapeMarkdownV2(asset)} on ${escapeMarkdownV2(chain)}.\n\nPlease link a bank account to receive your payout securely.`);
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ User ${escapeMarkdownV2(userId)} has received a deposit but hasn't linked a bank account.`);
        return res.status(200).send('OK');
      }

      const payout = calculatePayout(asset, amount);
      const referenceId = generateReferenceId();
      const rate = rates[asset] || 'N/A';
      const bankName = wallet.bank.bankName || 'N/A';
      const bankAccount = wallet.bank.accountNumber || 'N/A';
      const accountName = wallet.bank.accountName || 'N/A';

      // Notify User of Successful Deposit
      await bot.telegram.sendMessage(userId,
        `Dear ${escapeMarkdownV2(accountName)},\n\n` +
        `🎉 *Deposit Received*\n` +
        `- **Amount:** ${escapeMarkdownV2(amount)} ${escapeMarkdownV2(asset)}\n` +
        `- **Chain:** ${escapeMarkdownV2(chain)}\n` +
        `- **Wallet Address:** \`${escapeMarkdownV2(walletAddress)}\`\n\n` +
        `We are processing your transaction at a rate of *NGN ${escapeMarkdownV2(rate)}* per ${escapeMarkdownV2(asset)}.\n` +
        `You will receive *NGN ${escapeMarkdownV2(payout)}* in your ${escapeMarkdownV2(bankName)} account ending with ****${escapeMarkdownV2(bankAccount.slice(-4))} shortly.\n\n` +
        `Thank you for using *DirectPay*. We appreciate your trust in our services.\n\n` +
        `*Note:* If you have any questions, feel free to reach out to our support team.`,
        { parse_mode: 'MarkdownV2' }
      );

      // Notify Admin with Detailed Transaction Information
      const adminDepositMessage = `⚡️ *New Deposit Received*\n\n` +
        `*User ID:* ${escapeMarkdownV2(userId)}\n` +
        `*Amount Deposited:* ${escapeMarkdownV2(amount)} ${escapeMarkdownV2(asset)}\n` +
        `*Exchange Rate:* NGN ${escapeMarkdownV2(rate)} per ${escapeMarkdownV2(asset)}\n` +
        `*Amount to be Paid:* NGN ${escapeMarkdownV2(payout)}\n` +
        `*Time:* ${escapeMarkdownV2(new Date().toLocaleString())}\n` +
        `*Bank Details:*\n` +
        `  - *Account Name:* ${escapeMarkdownV2(accountName)}\n` +
        `  - *Bank Name:* ${escapeMarkdownV2(bankName)}\n` +
        `  - *Account Number:* ****${escapeMarkdownV2(bankAccount.slice(-4))}\n` +
        `*Chain:* ${escapeMarkdownV2(chain)}\n` +
        `*Transaction Hash:* \`${escapeMarkdownV2(transactionHash)}\`\n` +
        `*Reference ID:* ${escapeMarkdownV2(referenceId)}\n`;

      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, adminDepositMessage, { parse_mode: 'MarkdownV2' });

      // Store Transaction in Firestore
      await db.collection('transactions').add({
        userId,
        walletAddress,
        chain: chain,
        amount: amount,
        asset: asset,
        transactionHash: transactionHash,
        referenceId,
        bankDetails: wallet.bank,
        timestamp: new Date().toISOString(),
        status: 'Pending',
        payout: payout
      });

      logger.info(`Transaction stored for user ${userId}: Reference ID ${referenceId}`);

      return res.status(200).send('OK');
    } else {
      // Handle other event types if necessary
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `ℹ️ Unhandled event type: ${escapeMarkdownV2(eventType)}`);
      return res.status(200).send('OK');
    }
  } catch (error) {
    logger.error(`Error processing webhook: ${error.message}`);
    res.status(500).send('Error');
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error processing webhook: ${escapeMarkdownV2(error.message)}`);
  }
});

// Start Express Server
const port = process.env.PORT || 4000;
app.listen(port, () => {
  logger.info(`Webhook server running on port ${port}`);
});

// Global Error Handler for Telegraf
bot.catch((err, ctx) => {
  logger.error(`Unhandled error for update ${ctx.update.update_id}: ${err.message}`);
  // Optionally, notify admin about the error
  bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Unhandled error for update ${ctx.update.update_id}: ${escapeMarkdownV2(err.message)}`);
});

// Launch Bot with Correct Error Handling
bot.launch()
  .then(() => logger.info('DirectPay bot is live!'))
  .catch((err) => logger.error(`Error launching bot: ${err.message}`));

// Graceful Shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
