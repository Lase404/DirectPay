/******************************************************
 * DIRECTPAY-TG-BOT
 * DEV: TOLUWALASE ADUNBI
 *
 * Features:
 * - Paycrest for dynamic exchange rates
 * - Paystack for bank verification
 * - Blockradar for multi-chain wallet management
 * - Firebase Firestore for data storage
 * - Comprehensive UX enhancements:
 *   - Editing messages instead of sending new ones
 *   - Step-by-step progress indicators
 *   - Cancel and return buttons
 *   - Unified rates screen
 *   - Contextual FAQs after deposits
 *   - Additional "bot.hears" handlers for missing buttons
 *   - Generate new wallet directly from View Wallet
 *   - Immediate bank linking after wallet generation
 ******************************************************/

// -------- MODULES & CONFIGURATION --------
const { Telegraf, Markup, Scenes, session } = require('telegraf');
const axios = require('axios');
const admin = require('firebase-admin');
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const winston = require('winston');
require('dotenv').config();

// -------- WINSTON LOGGER SETUP --------
const logger = winston.createLogger({
  level: 'info', // Change to 'debug' for more detailed logs
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(
      ({ timestamp, level, message }) => `[${timestamp}] ${level.toUpperCase()}: ${message}`
    )
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'bot.log' }),
  ],
});

// -------- FIREBASE INITIALIZATION --------
const serviceAccount = require('./directpay.json'); // Ensure this file is secure
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://directpay9ja.firebaseio.com',
});
const db = admin.firestore();

// -------- ENVIRONMENT VARIABLES --------
const BOT_TOKEN = process.env.BOT_TOKEN;
const PAYCREST_API_KEY = process.env.PAYCREST_API_KEY;
const PAYCREST_CLIENT_SECRET = process.env.PAYCREST_CLIENT_SECRET;
const PAYCREST_RATE_API_URL = process.env.PAYCREST_RATE_API_URL || 'https://api.paycrest.io/v1/rates';
const PAYCREST_RETURN_ADDRESS = process.env.PAYCREST_RETURN_ADDRESS || '0xYourReturnAddressHere';
const PAYSTACK_API_KEY = process.env.PAYSTACK_SECRET_KEY;
const PERSONAL_CHAT_ID = process.env.PERSONAL_CHAT_ID;
const ADMIN_IDS = process.env.ADMIN_IDS
  ? process.env.ADMIN_IDS.split(',').map((id) => id.trim())
  : [];
const MAX_WALLETS = 5;

// -------- TELEGRAM WEBHOOK CONFIGURATION --------
const TELEGRAM_WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/webhook/telegram';
const WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN; // e.g., 'https://your-domain.com'
const TELEGRAM_WEBHOOK_URL = `${WEBHOOK_DOMAIN}${TELEGRAM_WEBHOOK_PATH}`;

// -------- BLOCKRADAR API KEY --------
const BLOCKRADAR_API_KEY =
  process.env.BLOCKRADAR_API_KEY || 'YOUR_BLOCKRADAR_API_KEY';

// -------- SUPPORTED ASSETS --------
const SUPPORTED_ASSETS = ['USDC', 'USDT'];

// -------- EXCHANGE RATES (DYNAMIC) --------
let exchangeRates = {
  USDC: 0,
  USDT: 0,
};

// -------- FUNCTION: FETCH SINGLE ASSET RATE FROM PAYCREST --------
async function fetchSingleAssetRate(asset) {
  try {
    const response = await axios.get(`${PAYCREST_RATE_API_URL}}`, {
      headers: {
        Authorization: `Bearer ${PAYCREST_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    if (response.data.status === 'success' && response.data.data) {
      const rate = parseFloat(response.data.data);
      if (isNaN(rate)) {
        throw new Error(`Invalid rate data for ${asset}: ${response.data.data}`);
      }
      return rate;
    } else {
      throw new Error(
        `Failed to fetch rate for ${asset}: ${response.data.message || 'Unknown error'}`
      );
    }
  } catch (error) {
    logger.error(
      `Error fetching exchange rate for ${asset} from Paycrest: ${error.message}`
    );
    throw error;
  }
}

// -------- FUNCTION: FETCH ALL EXCHANGE RATES --------
async function fetchExchangeRates() {
  try {
    const rates = {};
    for (const asset of SUPPORTED_ASSETS) {
      rates[asset] = await fetchSingleAssetRate(asset);
    }
    exchangeRates = rates;
    logger.info('Exchange rates updated successfully from Paycrest.');
  } catch (error) {
    logger.error(`Error fetching exchange rates from Paycrest: ${error.message}`);
    // Optionally retain previous rates or handle as needed
  }
}

// -------- INITIAL EXCHANGE RATE FETCH & SET INTERVAL --------
fetchExchangeRates();
setInterval(fetchExchangeRates, 300000); // Every 5 minutes

// -------- MULTI-CHAIN WALLET CONFIGURATION WITH BLOCKRADAR --------
const chains = {
  Base: {
    id: 'e31c44d6-0344-4ee1-bcd1-c88e89a9e3f1',
    key: 'i76FL4yzaRuYXPUzskM0Piodo5r08iJ1FUTgpuiylSDqYIVlcdEcPv5df3kbTvw',
    address: '0xfBeEC99b731B97271FF31E518c84d4a0E24B1118',
    apiUrl:
      'https://api.blockradar.co/v1/wallets/e31c44d6-0344-4ee1-bcd1-c88e89a9e3f1/addresses',
    supportedAssets: ['USDC', 'USDT'],
    network: 'Base',
  },
  Polygon: {
    id: 'f7d5b102-e94a-493a-8e0c-8da96fe70655',
    key: 'iXV8e72v9QLKcKfI4Nw8SkqKtEoyzAQFCFinIZKwj7pKUtFxaRMjlLCt5p3DZND',
    address: '0x9A52605A21e3bacD791579D980A975b258968041',
    apiUrl:
      'https://api.blockradar.co/v1/wallets/f7d5b102-e94a-493a-8e0c-8da96fe70655/addresses',
    supportedAssets: ['USDC', 'USDT'],
    network: 'Polygon',
  },
  'BNB Smart Chain': {
    id: '2cab1ef2-8589-4ff9-9017-76cc4d067719',
    key: '6HGRj2cdzULDUbrjGHZftwNyHswUZojxA40mQp77e5vDzWqJ6v13w2iE4DBHzu',
    address: '0x9A52605A21e3bacD791579D980A975b258968041',
    apiUrl:
      'https://api.blockradar.co/v1/wallets/2cab1ef2-8589-4ff9-9017-76cc4d067719/addresses',
    supportedAssets: ['USDC', 'USDT'],
    network: 'BNB Smart Chain',
  },
};

// -------- CHAIN MAPPING --------
const chainMapping = {
  base: 'Base',
  polygon: 'Polygon',
  'bnb smart chain': 'BNB Smart Chain',
  'bnb smartchain': 'BNB Smart Chain',
  'bnb chain': 'BNB Smart Chain',
  bnb: 'BNB Smart Chain',
};

// -------- BANK LIST WITH ALIASES, PAYCREST & PAYSTACK CODES --------
const bankList = [
  {
    bankName: 'Access Bank',
    paycrestCode: 'ABNGNGLA',
    paystackCode: '044',
    aliases: ['access', 'access bank', 'accessb', 'access bank nigeria'],
  },
  {
    bankName: 'Diamond Bank',
    paycrestCode: 'DBLNNGLA',
    paystackCode: '054',
    aliases: ['diamond', 'diamond bank', 'diamondb', 'diamond bank nigeria'],
  },
  // ... Add more banks as needed
  {
    bankName: 'Safe Haven MFB',
    paycrestCode: 'SAHVNGPC',
    paystackCode: '999994',
    aliases: ['safe haven', 'safe haven mfb', 'safe haven nigeria'],
  },
];

// -------- FUNCTION: VERIFY BANK ACCOUNT WITH PAYSTACK --------
async function verifyBankAccount(accountNumber, bankCode) {
  try {
    const response = await axios.get(
      `https://api.paystack.co/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`,
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_API_KEY}`,
        },
      }
    );
    return response.data;
  } catch (error) {
    logger.error(
      `Error verifying bank account (${accountNumber}, ${bankCode}): ${
        error.response ? error.response.data.message : error.message
      }`
    );
    throw new Error('Failed to verify bank account. Please try again later.');
  }
}

// -------- FUNCTION: CALCULATE PAYOUT --------
function calculatePayout(asset, amount) {
  const rate = exchangeRates[asset];
  if (!rate) {
    throw new Error(`Unsupported asset or missing rate: ${asset}`);
  }
  return (amount * rate).toFixed(2);
}

// -------- FUNCTION: GENERATE UNIQUE REFERENCE ID --------
function generateReferenceId() {
  return 'REF-' + Math.random().toString(36).substr(2, 9).toUpperCase();
}

// -------- MENUS --------
const getMainMenu = (walletExists, hasBankLinked) =>
  Markup.keyboard([
    [
      walletExists ? '💼 View Wallet' : '💼 Generate Wallet',
      hasBankLinked ? '🏦 Edit Bank Account' : '🏦 Link Bank Account',
    ],
    ['💰 Transactions', 'ℹ️ Support', '📘 Learn About Base'],
    ['📈 View Current Rates'],
  ]).resize();

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

// -------- FUNCTION: CHECK IF USER IS ADMIN --------
const isAdmin = (userId) => ADMIN_IDS.includes(userId.toString());

// -------- FIRESTORE HELPER FUNCTIONS --------
async function getUserState(userId) {
  try {
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      const defaultState = {
        wallets: [],
        walletAddresses: [],
        hasReceivedDeposit: false,
        awaitingBroadcastMessage: false,
      };
      await db.collection('users').doc(userId).set(defaultState);
      return defaultState;
    } else {
      const data = userDoc.data();
      return {
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

// -------- INITIALIZE BOT & EXPRESS --------
const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());

// -------- SCENES SETUP --------
const bankLinkingScene = new Scenes.BaseScene('bank_linking_scene');
const sendMessageScene = new Scenes.BaseScene('send_message_scene');

const stage = new Scenes.Stage([bankLinkingScene, sendMessageScene]);
bot.use(session());
bot.use(stage.middleware());

// -------- GREET /start --------
async function greetUser(ctx) {
  const userId = ctx.from.id.toString();
  let userState;
  try {
    userState = await getUserState(userId);
  } catch (error) {
    logger.error(`Error in greetUser: ${error.message}`);
    return ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
  }

  const hasWallets = userState.wallets.length > 0;
  const hasBankLinked = userState.wallets.some((wallet) => wallet.bank);

  const greeting = hasWallets
    ? `👋 Hello, ${ctx.from.first_name}!\n\nWelcome back to **DirectPay**, your gateway to secure and seamless crypto transactions.`
    : `👋 Welcome, ${ctx.from.first_name}!\n\nThank you for choosing **DirectPay**. We make it effortless to send and receive stablecoins. Use the menu below to begin.`;

  if (isAdmin(userId)) {
    const adminMsg = await ctx.replyWithMarkdown(
      greeting,
      Markup.inlineKeyboard([[Markup.button.callback('🔧 Admin Panel', 'open_admin_panel')]])
    );
    ctx.session.adminMessageId = adminMsg.message_id;
  } else {
    await ctx.replyWithMarkdown(greeting, getMainMenu(hasWallets, hasBankLinked));
  }
}

bot.start(async (ctx) => {
  await greetUser(ctx);
});

// -------- HEARS: EDIT BANK ACCOUNT --------
bot.hears(/🏦\s*Edit Bank Account/i, async (ctx) => {
  const userId = ctx.from.id.toString();
  let userState;

  try {
    userState = await getUserState(userId);
  } catch (error) {
    logger.error(`Error fetching user state for ${userId}: ${error.message}`);
    return ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
  }

  if (userState.wallets.length === 0) {
    return ctx.replyWithMarkdown('❌ You have no wallets to edit. Please generate a wallet first.');
  }

  // Prompt the user to choose which wallet to edit if multiple exist
  let selectionText = '*Please select the wallet you want to edit the bank account for:*';
  const walletButtons = userState.wallets.map((wallet, index) => [
    Markup.button.callback(`Wallet ${index + 1} (${wallet.chain})`, `edit_bank_wallet_${index}`),
  ]);

  await ctx.replyWithMarkdown(selectionText, Markup.inlineKeyboard(walletButtons));
});

// -------- ACTION: EDIT BANK WALLET CHOICE --------
bot.action(/edit_bank_wallet_(\d+)/, async (ctx) => {
  const walletIndex = parseInt(ctx.match[1], 10);
  ctx.session.walletIndex = walletIndex;
  ctx.session.processType = 'editing'; // indicates we are editing an existing bank
  await ctx.answerCbQuery('🔧 Editing bank details...');
  await ctx.scene.enter('bank_linking_scene');
});

// -------- HEARS: LINK BANK ACCOUNT --------
bot.hears(/🏦\s*Link Bank Account/i, async (ctx) => {
  const userId = ctx.from.id.toString();
  let userState;

  try {
    userState = await getUserState(userId);
  } catch (error) {
    logger.error(`Error fetching user state for ${userId}: ${error.message}`);
    return ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
  }

  if (userState.wallets.length === 0) {
    return ctx.replyWithMarkdown('❌ You have no wallets to link. Please generate a wallet first.');
  }

  // Prompt user to select which wallet to link if multiple
  let selectionText = '*Please select the wallet you want to link a bank account to:*';
  const buttons = userState.wallets.map((wallet, index) => [
    Markup.button.callback(`Wallet ${index + 1} (${wallet.chain})`, `link_bank_wallet_${index}`),
  ]);

  await ctx.replyWithMarkdown(selectionText, Markup.inlineKeyboard(buttons));
});

// -------- ACTION: LINK BANK WALLET CHOICE --------
bot.action(/link_bank_wallet_(\d+)/, async (ctx) => {
  const walletIndex = parseInt(ctx.match[1], 10);
  ctx.session.walletIndex = walletIndex;
  ctx.session.processType = 'linking';
  await ctx.answerCbQuery('🏦 Linking bank account...');
  await ctx.scene.enter('bank_linking_scene');
});

// -------- HEARS: VIEW WALLET (Add "Generate New Wallet" Option) --------
bot.hears(/💼\s*View Wallet/i, async (ctx) => {
  const userId = ctx.from.id.toString();
  let userState;

  try {
    userState = await getUserState(userId);
  } catch (error) {
    logger.error(`Error fetching user state for ${userId}: ${error.message}`);
    return ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
  }

  if (userState.wallets.length === 0) {
    return ctx.replyWithMarkdown(
      '❌ You have no wallets. Use "💼 Generate Wallet" to create one.',
      Markup.inlineKeyboard([
        [Markup.button.callback('➕ Generate Wallet', 'view_wallet_generate')],
      ])
    );
  }

  // Show current wallets with a button to generate a new one
  await displayWallets(ctx, 1);
  await ctx.replyWithMarkdown(
    'Would you like to create another wallet?',
    Markup.inlineKeyboard([
      [Markup.button.callback('➕ Generate Another Wallet', 'view_wallet_generate')],
    ])
  );
});

// -------- ACTION: Generate Another Wallet from "View Wallet" --------
bot.action('view_wallet_generate', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.replyWithMarkdown(
    'Please select the blockchain network for your new wallet:',
    Markup.inlineKeyboard([
      [Markup.button.callback('Base', 'generate_wallet_Base')],
      [Markup.button.callback('Polygon', 'generate_wallet_Polygon')],
      [Markup.button.callback('BNB Smart Chain', 'generate_wallet_BNB Smart Chain')],
    ])
  );
});

// -------- GENERATE WALLET HANDLER --------
bot.hears(/💼\s*Generate Wallet/i, async (ctx) => {
  await ctx.replyWithMarkdown(
    '🔐 *Wallet Generation*\n\nPlease select the blockchain network where you want to generate your wallet:',
    Markup.inlineKeyboard([
      [Markup.button.callback('Base', 'generate_wallet_Base')],
      [Markup.button.callback('Polygon', 'generate_wallet_Polygon')],
      [Markup.button.callback('BNB Smart Chain', 'generate_wallet_BNB Smart Chain')],
    ])
  );
});

// -------- ACTION HANDLER: GENERATE WALLET --------
bot.action(/generate_wallet_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const chainRaw = ctx.match[1];
  const chainKey = chainMapping[chainRaw.toLowerCase()];

  if (!chainKey || !chains[chainKey]) {
    await ctx.answerCbQuery('❌ Unknown chain selected.', { show_alert: true });
    return;
  }

  await ctx.answerCbQuery(`🔄 Generating wallet on ${chainKey}...`);

  // Indicate processing
  const processingMsg = await ctx.replyWithMarkdown(`🔄 Generating your wallet on *${chainKey}*...`);

  try {
    const walletAddress = await generateWalletOnChain(chainKey);
    let userState = await getUserState(userId);

    if (userState.wallets.length >= MAX_WALLETS) {
      await ctx.replyWithMarkdown(`⚠️ You cannot generate more than ${MAX_WALLETS} wallets.`);
      await ctx.deleteMessage(processingMsg.message_id);
      return;
    }

    userState.wallets.push({
      address: walletAddress,
      chain: chainKey,
      supportedAssets: chains[chainKey].supportedAssets || [],
      bank: null,
    });
    userState.walletAddresses.push(walletAddress);

    await updateUserState(userId, {
      wallets: userState.wallets,
      walletAddresses: userState.walletAddresses,
    });

    await ctx.deleteMessage(processingMsg.message_id);

    const successMsg = `✅ *Wallet Created on ${chainKey}*\n\n• **Address:** \`${walletAddress}\`\n• **Supported Assets:** ${chains[chainKey].supportedAssets.join(
      ', '
    )}\n\n*Next Step:*\n• *Link Your Bank Account*`;

    await ctx.replyWithMarkdown(successMsg, Markup.inlineKeyboard([
      [Markup.button.callback('🏦 Link Bank Now', 'link_bank_now')],
    ]));

    // Automatically start bank linking scene
    ctx.session.walletIndex = userState.wallets.length - 1;
    ctx.session.processType = 'linking';
    await ctx.scene.enter('bank_linking_scene');
  } catch (error) {
    logger.error(`Error generating wallet: ${error.message}`);
    await ctx.replyWithMarkdown(`⚠️ Failed to generate wallet: ${error.message}`);
    await ctx.deleteMessage(processingMsg.message_id);
  }
});

// -------- FUNCTION: GENERATE WALLET ON CHAIN --------
async function generateWalletOnChain(chainKey) {
  try {
    const response = await axios.post(
      chains[chainKey].apiUrl,
      {
        name: `DirectPay_User_Wallet_${chainKey}`,
      },
      {
        headers: {
          'x-api-key': chains[chainKey].key,
          'Content-Type': 'application/json',
        },
      }
    );

    const walletAddress = response.data.data.address;
    if (!walletAddress) {
      throw new Error('No wallet address returned from Blockradar.');
    }

    return walletAddress;
  } catch (error) {
    logger.error(`Error generating wallet on ${chainKey}: ${error.response?.data?.message || error.message}`);
    throw new Error(`Could not generate wallet on ${chainKey}. Please try again.`);
  }
}

// -------- ACTION HANDLER: LINK BANK NOW --------
bot.action('link_bank_now', async (ctx) => {
  const userId = ctx.from.id.toString();
  let userState;

  try {
    userState = await getUserState(userId);
  } catch (error) {
    logger.error(`Error fetching user state for ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
    return;
  }

  if (userState.wallets.length === 0) {
    await ctx.replyWithMarkdown('❌ You have no wallets to link a bank account to. Please generate a wallet first.');
    return;
  }

  // Prompt user to select a wallet to link bank
  let walletSelectionText = '*Select a Wallet to Link Your Bank Account:*';
  const walletButtons = userState.wallets.map((wallet, index) => [
    Markup.button.callback(`Wallet ${index + 1}: ${wallet.chain}`, `link_bank_wallet_${index}`),
  ]);

  await ctx.replyWithMarkdown(walletSelectionText, Markup.inlineKeyboard(walletButtons));
});

// -------- ACTION HANDLER: SELECT WALLET FOR BANK LINKING --------
bot.action(/link_bank_wallet_(\d+)/, async (ctx) => {
  const walletIndex = parseInt(ctx.match[1], 10);
  const userId = ctx.from.id.toString();

  let userState;
  try {
    userState = await getUserState(userId);
  } catch (error) {
    logger.error(`Error fetching user state for ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
    return;
  }

  if (walletIndex < 0 || walletIndex >= userState.wallets.length) {
    await ctx.answerCbQuery('⚠️ Invalid wallet selected.', { show_alert: true });
    return;
  }

  ctx.session.walletIndex = walletIndex;
  ctx.session.processType = 'linking';

  // Start bank linking scene
  await ctx.scene.enter('bank_linking_scene');
});

// -------- SCENE: BANK LINKING --------
bankLinkingScene.enter(async (ctx) => {
  const userId = ctx.from.id.toString();
  let userState;

  try {
    userState = await getUserState(userId);
  } catch (error) {
    logger.error(`Error in bankLinkingScene.enter: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
    return ctx.scene.leave();
  }

  const walletIndex = ctx.session.walletIndex;
  const wallet = userState.wallets[walletIndex];

  if (!wallet) {
    await ctx.replyWithMarkdown('⚠️ Wallet not found. Please try again.');
    return ctx.scene.leave();
  }

  ctx.session.bankData = { step: 1 };
  ctx.session.isBankLinking = true;

  // Start bank linking steps with progress indicator
  const prompt = `🏦 *Bank Linking - Step 1 of 3*\n\nPlease enter your bank name (e.g., Access Bank):`;
  await ctx.replyWithMarkdown(prompt, Markup.inlineKeyboard([
    [Markup.button.callback('❌ Cancel Linking', 'cancel_bank_linking')],
  ]));

  // Set inactivity timeout (5 minutes)
  ctx.session.bankLinkingTimeout = setTimeout(() => {
    if (ctx.session.isBankLinking) {
      ctx.replyWithMarkdown('⏰ Bank linking process timed out due to inactivity.');
      ctx.scene.leave();
    }
  }, 300000); // 5 minutes
});

// Handle text input within bankLinkingScene
bankLinkingScene.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const input = ctx.message.text.trim().toLowerCase();

  // Clear inactivity timeout
  if (ctx.session.bankLinkingTimeout) {
    clearTimeout(ctx.session.bankLinkingTimeout);
  }

  let step = ctx.session.bankData.step;

  if (step === 1) {
    // Step 1: Enter Bank Name
    const bankItem = bankList.find((b) => b.aliases.includes(input));
    if (!bankItem) {
      return ctx.replyWithMarkdown(
        '❌ Invalid bank name. Please enter a valid bank from our supported list:\n\n' +
        bankList.map((b) => `• ${b.bankName}`).join('\n')
      );
    }

    ctx.session.bankData.bankName = bankItem.bankName;
    ctx.session.bankData.paystackCode = bankItem.paystackCode;
    ctx.session.bankData.paycrestCode = bankItem.paycrestCode;
    ctx.session.bankData.step = 2;

    // Proceed to Step 2
    const step2Prompt = `🔢 *Bank Linking - Step 2 of 3*\n\nPlease enter your 10-digit bank account number:`;
    await ctx.replyWithMarkdown(step2Prompt, Markup.inlineKeyboard([
      [Markup.button.callback('❌ Cancel Linking', 'cancel_bank_linking')],
    ]));

    // Restart inactivity timeout
    ctx.session.bankLinkingTimeout = setTimeout(() => {
      if (ctx.session.isBankLinking) {
        ctx.replyWithMarkdown('⏰ Bank linking process timed out due to inactivity.');
        ctx.scene.leave();
      }
    }, 300000); // 5 minutes

  } else if (step === 2) {
    // Step 2: Enter Account Number
    if (!/^\d{10}$/.test(input)) {
      return ctx.replyWithMarkdown('❌ Invalid account number. Please enter a valid 10-digit account number:');
    }

    ctx.session.bankData.accountNumber = input;
    ctx.session.bankData.step = 3;

    // Proceed to Step 3: Verification
    const verifyingMsg = await ctx.replyWithMarkdown('🔄 Verifying your bank account details...');
    try {
      const verification = await verifyBankAccount(input, ctx.session.bankData.paystackCode);
      if (!verification || !verification.data) {
        throw new Error('Invalid verification response.');
      }

      const accountName = verification.data.account_name;
      if (!accountName) {
        throw new Error('Account name not found.');
      }

      ctx.session.bankData.accountName = accountName;
      ctx.session.bankData.step = 4;

      // Delete verification message
      await ctx.deleteMessage(verifyingMsg.message_id);

      // Proceed to Step 4: Confirmation
      const confirmationMsg = `🏦 *Bank Linking - Step 3 of 3*\n\nPlease confirm your bank details:\n\n• **Bank Name:** ${ctx.session.bankData.bankName}\n• **Account Number:** \`${ctx.session.bankData.accountNumber}\`\n• **Account Holder:** ${accountName}\n\nIs this information correct?`;
      await ctx.replyWithMarkdown(confirmationMsg, Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes, Confirm', 'confirm_bank_yes')],
        [Markup.button.callback('❌ No, Edit Details', 'confirm_bank_no')],
        [Markup.button.callback('❌ Cancel Linking', 'cancel_bank_linking')],
      ]));

      // Restart inactivity timeout
      ctx.session.bankLinkingTimeout = setTimeout(() => {
        if (ctx.session.isBankLinking) {
          ctx.replyWithMarkdown('⏰ Bank linking process timed out due to inactivity.');
          ctx.scene.leave();
        }
      }, 300000); // 5 minutes

    } catch (error) {
      logger.error(`Bank verification failed for user ${userId}: ${error.message}`);
      await ctx.replyWithMarkdown('❌ Failed to verify your bank account. Please ensure your details are correct or try again later.');
      ctx.scene.leave();
    }
  }
});

// Handle confirmation of bank details
bankLinkingScene.action('confirm_bank_yes', async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = ctx.session.walletIndex;
  let userState;

  try {
    userState = await getUserState(userId);
  } catch (error) {
    logger.error(`Error fetching user state for ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
    return ctx.scene.leave();
  }

  const wallet = userState.wallets[walletIndex];
  if (!wallet) {
    await ctx.replyWithMarkdown('⚠️ Wallet not found. Please try again.');
    return ctx.scene.leave();
  }

  // Link bank details to the wallet
  wallet.bank = {
    bankName: ctx.session.bankData.bankName,
    paycrestCode: ctx.session.bankData.paycrestCode,
    paystackCode: ctx.session.bankData.paystackCode,
    accountNumber: ctx.session.bankData.accountNumber,
    accountName: ctx.session.bankData.accountName,
  };

  try {
    await updateUserState(userId, { wallets: userState.wallets });

    // Notify user of successful linking
    const successMsg = `✅ *Bank Account Linked Successfully!*\n\n• **Bank Name:** ${wallet.bank.bankName}\n• **Account Number:** \`${wallet.bank.accountNumber}\`\n• **Account Holder:** ${wallet.bank.accountName}\n\nYou can view your wallet details using the "💼 View Wallet" option.`;
    await ctx.replyWithMarkdown(successMsg, getMainMenu(true, true));

    // Notify admin
    await bot.telegram.sendMessage(
      PERSONAL_CHAT_ID,
      `🔗 User ${userId} linked a bank account:\n\n• **Bank Name:** ${wallet.bank.bankName}\n• **Account Number:** ****${wallet.bank.accountNumber.slice(-4)}\n• **Account Holder:** ${wallet.bank.accountName}`,
      { parse_mode: 'Markdown' }
    );

    // Cleanup
    delete ctx.session.bankData;
    delete ctx.session.isBankLinking;
    delete ctx.session.walletIndex;
    delete ctx.session.processType;

    if (ctx.session.bankLinkingTimeout) {
      clearTimeout(ctx.session.bankLinkingTimeout);
      delete ctx.session.bankLinkingTimeout;
    }

    ctx.scene.leave();
  } catch (error) {
    logger.error(`Error linking bank account for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ Failed to link bank account. Please try again later.');
    ctx.scene.leave();
  }
});

// Handle declining to confirm bank details
bankLinkingScene.action('confirm_bank_no', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session.bankData.step = 1; // Restart from Step 1

  await ctx.replyWithMarkdown('❌ Let\'s try linking your bank account again.');

  // Restart the bank linking scene
  await ctx.scene.reenter();
});

// Handle cancelling bank linking
bankLinkingScene.action('cancel_bank_linking', async (ctx) => {
  await ctx.replyWithMarkdown('❌ Bank linking process has been canceled.');

  // Cleanup session variables
  delete ctx.session.bankData;
  delete ctx.session.isBankLinking;
  delete ctx.session.walletIndex;
  delete ctx.session.processType;

  if (ctx.session.bankLinkingTimeout) {
    clearTimeout(ctx.session.bankLinkingTimeout);
    delete ctx.session.bankLinkingTimeout;
  }

  ctx.scene.leave();
});

// -------- VIEW WALLET HANDLER --------
bot.hears(/💼\s*View Wallet/i, async (ctx) => {
  const userId = ctx.from.id.toString();
  let userState;
  
  try {
    userState = await getUserState(userId);
  } catch (error) {
    logger.error(`Error fetching user state for ${userId}: ${error.message}`);
    return ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
  }

  if (userState.wallets.length === 0) {
    return ctx.replyWithMarkdown(
      '❌ You have no wallets. Use "💼 Generate Wallet" to create one.',
      Markup.inlineKeyboard([
        [Markup.button.callback('➕ Generate Wallet', 'view_wallet_generate')],
      ])
    );
  }

  // Build wallet message with pagination if necessary
  await displayWallets(ctx, 1);
  await ctx.replyWithMarkdown(
    'Would you like to create another wallet?',
    Markup.inlineKeyboard([
      [Markup.button.callback('➕ Generate Another Wallet', 'view_wallet_generate')],
    ])
  );
});

// -------- FUNCTION: DISPLAY WALLETS WITH PAGINATION --------
async function displayWallets(ctx, page = 1) {
  const userId = ctx.from.id.toString();
  let userState;
  
  try {
    userState = await getUserState(userId);
  } catch (error) {
    logger.error(`Error in displayWallets: ${error.message}`);
    return ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
  }

  const wallets = userState.wallets;
  const itemsPerPage = 5;
  const totalPages = Math.ceil(wallets.length / itemsPerPage);

  if (page < 1) page = 1;
  if (page > totalPages) page = totalPages;

  const startIdx = (page - 1) * itemsPerPage;
  const endIdx = page * itemsPerPage;
  const walletsPage = wallets.slice(startIdx, endIdx);

  let walletMsg = `💼 *Your Wallets (Page ${page} of ${totalPages})*\n\n`;
  walletsPage.forEach((wallet, index) => {
    walletMsg += `• *Wallet ${startIdx + index + 1}:*\n  • *Chain:* ${wallet.chain}\n  • *Address:* \`${wallet.address}\`\n  • *Bank Linked:* ${wallet.bank ? '✅ Yes' : '❌ No'}\n\n`;
  });

  const navigationButtons = [];
  if (page > 1) navigationButtons.push(Markup.button.callback('⏮ Previous', `wallet_page_${page - 1}`));
  if (page < totalPages) navigationButtons.push(Markup.button.callback('Next ⏭', `wallet_page_${page + 1}`));
  navigationButtons.push(Markup.button.callback('🔙 Main Menu', 'back_to_main_menu'));

  await ctx.replyWithMarkdown(walletMsg, Markup.inlineKeyboard([navigationButtons]));
}

// -------- ACTION HANDLER: PAGINATION FOR WALLETS --------
bot.action(/wallet_page_(\d+)/, async (ctx) => {
  const newPage = parseInt(ctx.match[1], 10);
  await ctx.answerCbQuery();
  await displayWallets(ctx, newPage);
});

// -------- FUNCTION: DISPLAY TRANSACTIONS WITH PAGINATION --------
async function showTransactions(ctx, page = 1) {
  const userId = ctx.from.id.toString();
  let userState;

  try {
    userState = await getUserState(userId);
  } catch (error) {
    logger.error(`Error fetching user state for ${userId}: ${error.message}`);
    return ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
  }

  const snapshot = await db
    .collection('transactions')
    .where('userId', '==', userId)
    .orderBy('timestamp', 'desc')
    .get();

  if (snapshot.empty) {
    return ctx.replyWithMarkdown('💰 You have no transactions yet.');
  }

  const allTransactions = snapshot.docs.map((doc) => doc.data());
  const itemsPerPage = 5;
  const totalPages = Math.ceil(allTransactions.length / itemsPerPage);

  if (page < 1) page = 1;
  if (page > totalPages) page = totalPages;

  const startIdx = (page - 1) * itemsPerPage;
  const endIdx = page * itemsPerPage;
  const transactionsPage = allTransactions.slice(startIdx, endIdx);

  let txMsg = `💰 *Your Transactions (Page ${page} of ${totalPages})*\n\n`;
  transactionsPage.forEach((tx) => {
    txMsg += `• *Reference ID:* \`${tx.referenceId || 'N/A'}\`\n  • *Amount:* ${tx.amount || 'N/A'} ${tx.asset || 'N/A'}\n  • *Status:* ${tx.status || 'Pending'}\n  • *Date:* ${
      tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'
    }\n\n`;
  });

  const navigationButtons = [];
  if (page > 1) navigationButtons.push(Markup.button.callback('⏮ Previous', `tx_page_${page - 1}`));
  if (page < totalPages) navigationButtons.push(Markup.button.callback('Next ⏭', `tx_page_${page + 1}`));
  navigationButtons.push(Markup.button.callback('🔙 Main Menu', 'back_to_main_menu'));

  await ctx.replyWithMarkdown(txMsg, Markup.inlineKeyboard([navigationButtons]));
}

// -------- ACTION HANDLER: PAGINATION FOR TRANSACTIONS --------
bot.action(/tx_page_(\d+)/, async (ctx) => {
  const newPage = parseInt(ctx.match[1], 10);
  await ctx.answerCbQuery();
  await showTransactions(ctx, newPage);
});

// -------- VIEW CURRENT RATES HANDLER --------
bot.hears(/📈\s*View Current Rates/i, async (ctx) => {
  const ratesMsg = `📈 *Current Paycrest Rates:*\n\n• **USDC:** ₦${exchangeRates.USDC}\n• **USDT:** ₦${exchangeRates.USDT}\n\n*(Rates update every 5 minutes)*`;
  await ctx.replyWithMarkdown(ratesMsg, Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Refresh Rates', 'refresh_rates')],
    [Markup.button.callback('🔙 Main Menu', 'back_to_main_menu')],
  ]));
});

// -------- ACTION HANDLER: REFRESH RATES --------
bot.action('refresh_rates', async (ctx) => {
  await ctx.answerCbQuery('🔄 Refreshing rates...');
  try {
    await fetchExchangeRates();
  } catch (error) {
    // Handle error if needed
  }

  const updatedRatesMsg = `📈 *Updated Paycrest Rates:*\n\n• **USDC:** ₦${exchangeRates.USDC}\n• **USDT:** ₦${exchangeRates.USDT}\n\n*(Rates update every 5 minutes)*`;
  await ctx.editMessageText(updatedRatesMsg, {
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Refresh Rates', 'refresh_rates')],
      [Markup.button.callback('🔙 Main Menu', 'back_to_main_menu')],
    ]).reply_markup,
  });
});

// -------- SUPPORT HANDLER --------
bot.hears(/ℹ️\s*Support/i, async (ctx) => {
  await ctx.replyWithMarkdown(
    '🛠️ *Support Menu*\n\nHow can we assist you today?',
    Markup.inlineKeyboard([
      [Markup.button.callback('❓ How It Works', 'support_how_it_works')],
      [Markup.button.callback('⚠️ Transaction Not Received', 'support_tx_not_received')],
      [Markup.button.callback('💬 Contact Support', 'support_contact')],
    ])
  );
});

// -------- ACTION HANDLERS: SUPPORT --------
bot.action('support_how_it_works', async (ctx) => {
  await ctx.answerCbQuery();
  const howItWorksMsg = `📘 *How DirectPay Works*\n\n1. *Generate Your Wallet*: Create a dedicated wallet on your chosen blockchain.\n2. *Link Your Bank Account*: Connect your bank for seamless fiat transactions.\n3. *Deposit Stablecoins*: Send USDC or USDT to your wallet.\n4. *Automatic Conversion*: We convert your stablecoins to NGN at competitive rates.\n5. *Instant Payout*: Receive the converted amount directly in your bank account.\n\nFor more details, refer to our [documentation](https://your-docs-link.com).`;
  try {
    await ctx.editMessageText(howItWorksMsg, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Support Menu', 'back_to_support_menu')],
      ]).reply_markup,
    });
  } catch (error) {
    // If message can't be edited (e.g., too old), send a new one
    await ctx.replyWithMarkdown(howItWorksMsg, Markup.inlineKeyboard([
      [Markup.button.callback('🔙 Support Menu', 'back_to_support_menu')],
    ]));
  }
});

bot.action('support_tx_not_received', async (ctx) => {
  await ctx.answerCbQuery();
  const txIssueMsg = `⚠️ *Transaction Not Received*\n\nIf you haven't received your payout, please check the following:\n\n• Ensure the deposit transaction is confirmed on the blockchain.\n• Verify your bank account details are correct.\n• Check the transaction status in the "💰 Transactions" section.\n\nIf the issue persists, contact our support team for assistance.`;
  try {
    await ctx.editMessageText(txIssueMsg, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Support Menu', 'back_to_support_menu')],
      ]).reply_markup,
    });
  } catch (error) {
    await ctx.replyWithMarkdown(txIssueMsg, Markup.inlineKeyboard([
      [Markup.button.callback('🔙 Support Menu', 'back_to_support_menu')],
    ]));
  }
});

bot.action('support_contact', async (ctx) => {
  await ctx.answerCbQuery();
  const contactMsg = `💬 *Contact Support*\n\nYou can reach our support team at [@your_support_username](https://t.me/your_support_username) for any assistance or queries.`;
  try {
    await ctx.editMessageText(contactMsg, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Support Menu', 'back_to_support_menu')],
      ]).reply_markup,
    });
  } catch (error) {
    await ctx.replyWithMarkdown(contactMsg, Markup.inlineKeyboard([
      [Markup.button.callback('🔙 Support Menu', 'back_to_support_menu')],
    ]));
  }
});

// -------- ACTION HANDLER: BACK TO SUPPORT MENU --------
bot.action('back_to_support_menu', async (ctx) => {
  await ctx.answerCbQuery();
  const supportMenuMsg = '🛠️ *Support Menu*\n\nHow can we assist you today?';
  try {
    await ctx.editMessageText(supportMenuMsg, {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('❓ How It Works', 'support_how_it_works')],
        [Markup.button.callback('⚠️ Transaction Not Received', 'support_tx_not_received')],
        [Markup.button.callback('💬 Contact Support', 'support_contact')],
      ]).reply_markup,
    });
  } catch (error) {
    await ctx.replyWithMarkdown(supportMenuMsg, Markup.inlineKeyboard([
      [Markup.button.callback('❓ How It Works', 'support_how_it_works')],
      [Markup.button.callback('⚠️ Transaction Not Received', 'support_tx_not_received')],
      [Markup.button.callback('💬 Contact Support', 'support_contact')],
    ]));
  }
});

// -------- LEARN ABOUT BASE HANDLER --------
const baseContent = [
  {
    title: 'Welcome to Base',
    text: 'Base is a secure, low-cost blockchain solution that powers DirectPay’s multi-chain wallets. It ensures fast and reliable transactions for all your crypto needs.',
  },
  {
    title: 'Why Choose Base?',
    text: '- **Low Fees**: Save more with minimal transaction costs.\n- **Fast Transactions**: Experience near-instant transfers.\n- **Security**: Advanced security protocols to protect your assets.',
  },
  {
    title: 'Getting Started',
    text: 'To start using Base, simply generate a wallet on your preferred blockchain (Base, Polygon, or BNB Smart Chain), link your bank account, and begin transacting seamlessly.',
  },
  {
    title: 'Learn More',
    text: 'Visit the official documentation at [Base Docs](https://base-docs-link.com) for comprehensive guides and support.',
  },
];

async function sendBaseContent(ctx, index, isNew = false) {
  const content = baseContent[index];
  const totalPages = baseContent.length;

  const navigationButtons = [];
  if (index > 0) {
    navigationButtons.push(Markup.button.callback('⬅️ Previous', `base_page_${index - 1}`));
  }
  if (index < totalPages - 1) {
    navigationButtons.push(Markup.button.callback('Next ➡️', `base_page_${index + 1}`));
  }
  navigationButtons.push(Markup.button.callback('🔚 Exit', 'exit_base'));

  const inlineKeyboard = Markup.inlineKeyboard([navigationButtons]);

  if (isNew) {
    const sentMessage = await ctx.replyWithMarkdown(
      `**${content.title}**\n\n${content.text}`,
      inlineKeyboard
    );
    ctx.session.baseMessageId = sentMessage.message_id;
  } else {
    try {
      await ctx.editMessageText(`**${content.title}**\n\n${content.text}`, {
        parse_mode: 'Markdown',
        reply_markup: inlineKeyboard.reply_markup,
      });
    } catch (error) {
      // If the message can't be edited (e.g., too old), send a new one
      const sentMessage = await ctx.replyWithMarkdown(
        `**${content.title}**\n\n${content.text}`,
        inlineKeyboard
      );
      ctx.session.baseMessageId = sentMessage.message_id;
    }
  }

  // Optional: Delete the message after a certain time to keep chat clean
  setTimeout(() => {
    if (ctx.session.baseMessageId) {
      ctx.deleteMessage(ctx.session.baseMessageId).catch(() => {});
      ctx.session.baseMessageId = null;
    }
  }, 120000); // 2 minutes
}

bot.hears(/📘\s*Learn About Base/i, async (ctx) => {
  await sendBaseContent(ctx, 0, true);
});

// -------- ACTION HANDLER: LEARN ABOUT BASE PAGES --------
bot.action(/base_page_(\d+)/, async (ctx) => {
  const page = parseInt(ctx.match[1], 10);
  if (isNaN(page) || page < 0 || page >= baseContent.length) {
    await ctx.answerCbQuery('⚠️ Invalid page number.', { show_alert: true });
    return;
  }
  await sendBaseContent(ctx, page);
  await ctx.answerCbQuery();
});

// -------- ACTION HANDLER: EXIT BASE LEARN MORE --------
bot.action('exit_base', async (ctx) => {
  await ctx.answerCbQuery();
  if (ctx.session.baseMessageId) {
    await ctx.deleteMessage(ctx.session.baseMessageId).catch(() => {});
    ctx.session.baseMessageId = null;
  }
  await ctx.replyWithMarkdown('🔚 You have exited the "Learn About Base" section.', getMainMenu(true, true));
});

// -------- ADMIN PANEL HANDLERS --------

// Example: View All Transactions (Admin)
bot.action('admin_view_transactions', async (ctx) => {
  await ctx.answerCbQuery();
  // Placeholder: Implement viewing all transactions
  await ctx.replyWithMarkdown('📋 *View All Transactions*\n\nFeature under development.');
});

// Example: Send Message to User (Admin)
bot.action('admin_send_message', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session.sendMessageMode = true;
  await ctx.replyWithMarkdown('📩 *Send Message to User*\n\nPlease enter the User ID you want to message:');
});

// Example: Mark Transactions as Paid (Admin)
bot.action('admin_mark_paid', async (ctx) => {
  await ctx.answerCbQuery();
  // Placeholder: Implement marking transactions as paid
  await ctx.replyWithMarkdown('✅ *Mark Transactions as Paid*\n\nPlease enter the Reference ID of the transaction to mark as paid:');
  ctx.session.markPaidMode = true;
});

// Example: View All Users (Admin)
bot.action('admin_view_users', async (ctx) => {
  await ctx.answerCbQuery();
  // Placeholder: Implement viewing all users
  await ctx.replyWithMarkdown('👥 *View All Users*\n\nFeature under development.');
});

// Example: Broadcast Message (Admin)
bot.action('admin_broadcast_message', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session.broadcastMode = true;
  await ctx.replyWithMarkdown('📢 *Broadcast Message*\n\nPlease enter the message you want to broadcast to all users:');
});

// Example: Manage Banks (Admin)
bot.action('admin_manage_banks', async (ctx) => {
  await ctx.answerCbQuery();
  // Placeholder: Implement managing banks
  await ctx.replyWithMarkdown('🏦 *Manage Banks*\n\nFeature under development.');
});

// Example: Back to Admin Menu
bot.action('admin_back_to_main', async (ctx) => {
  await ctx.answerCbQuery();
  const adminMsg = `👨‍💼 *Admin Panel*\n\nSelect an option below:`;
  await ctx.editMessageText(adminMsg, {
    parse_mode: 'Markdown',
    reply_markup: getAdminMenu().reply_markup,
  });
});

// -------- SEND MESSAGE SCENE HANDLER --------
sendMessageScene.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();

  if (ctx.session.sendMessageMode) {
    const targetUserId = ctx.message.text.trim();
    if (!/^\d+$/.test(targetUserId)) {
      return ctx.replyWithMarkdown('❌ Invalid User ID. Please enter a numeric User ID:');
    }

    // Check if user exists
    const userDoc = await db.collection('users').doc(targetUserId).get();
    if (!userDoc.exists) {
      return ctx.replyWithMarkdown('❌ User not found. Please enter a valid User ID:');
    }

    ctx.session.targetUserId = targetUserId;
    ctx.session.sendMessageMode = false;
    ctx.session.awaitingMessage = true;

    await ctx.replyWithMarkdown('📝 Enter the message you want to send to the user:');
  } else if (ctx.session.broadcastMode) {
    const broadcastMsg = ctx.message.text.trim();
    if (!broadcastMsg) {
      return ctx.replyWithMarkdown('❌ Message cannot be empty. Please enter a valid message:');
    }

    // Fetch all user IDs
    const usersSnapshot = await db.collection('users').get();
    const allUserIds = usersSnapshot.docs.map((doc) => doc.id);

    // Send message to each user
    for (const uid of allUserIds) {
      try {
        await bot.telegram.sendMessage(uid, `📢 *Broadcast Message from Admin:*\n\n${broadcastMsg}`, {
          parse_mode: 'Markdown',
        });
      } catch (error) {
        logger.error(`Failed to send broadcast to ${uid}: ${error.message}`);
      }
    }

    await ctx.replyWithMarkdown('📢 Broadcast message sent to all users.');
    ctx.session.broadcastMode = false;
    await ctx.replyWithMarkdown('👨‍💼 *Admin Panel*\n\nSelect an option below:', getAdminMenu());
  }
});

sendMessageScene.leave((ctx) => {
  delete ctx.session.targetUserId;
  delete ctx.session.awaitingUserId;
  delete ctx.session.awaitingBroadcast;
  delete ctx.session.awaitingMessage;
});

// -------- SEND MESSAGE AFTER ADMIN SENDS TEXT --------
bot.on('message', async (ctx) => {
  const userId = ctx.from.id.toString();

  if (ctx.session.targetUserId && ctx.session.awaitingMessage) {
    const messageContent = ctx.message.text.trim();
    const targetUserId = ctx.session.targetUserId;

    try {
      await bot.telegram.sendMessage(
        targetUserId,
        `📩 *Message from Admin:*\n\n${messageContent}`,
        { parse_mode: 'Markdown' }
      );
      await ctx.replyWithMarkdown('✅ Message sent successfully.');
    } catch (error) {
      logger.error(`Error sending message to ${targetUserId}: ${error.message}`);
      await ctx.replyWithMarkdown('⚠️ Failed to send the message. The user might have blocked the bot.');
    }

    // Cleanup
    delete ctx.session.targetUserId;
    delete ctx.session.awaitingMessage;
    ctx.scene.leave();
  }

  if (ctx.session.markPaidMode) {
    const referenceId = ctx.message.text.trim();
    if (!referenceId) {
      return ctx.replyWithMarkdown('❌ Reference ID cannot be empty. Please enter a valid Reference ID:');
    }

    try {
      await markTransactionAsPaid(referenceId);
      await ctx.replyWithMarkdown(`✅ Transaction \`${referenceId}\` has been marked as *Paid*.`);
    } catch (error) {
      await ctx.replyWithMarkdown(`⚠️ Failed to mark transaction as paid: ${error.message}`);
    }

    // Cleanup
    delete ctx.session.markPaidMode;
  }

  // Add additional handlers if necessary
});

// -------- FUNCTION: SEND MESSAGE TO USER --------
async function sendMessageToUser(ctx, messageContent) {
  const targetUserId = ctx.session.targetUserId;
  try {
    await bot.telegram.sendMessage(
      targetUserId,
      `📩 *Message from Admin:*\n\n${messageContent}`,
      { parse_mode: 'Markdown' }
    );
    await ctx.replyWithMarkdown('✅ Message sent successfully.');
  } catch (error) {
    logger.error(`Error sending message to ${targetUserId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ Failed to send the message. The user might have blocked the bot.');
  }

  // Cleanup
  delete ctx.session.targetUserId;
}

// -------- FUNCTION: MARK TRANSACTION AS PAID --------
async function markTransactionAsPaid(referenceId) {
  try {
    const txDoc = await db.collection('transactions').doc(referenceId).get();
    if (!txDoc.exists) {
      throw new Error('Transaction not found.');
    }

    await db.collection('transactions').doc(referenceId).update({
      status: 'Paid',
      paidAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Notify user
    const txData = txDoc.data();
    await bot.telegram.sendMessage(
      txData.userId,
      `✅ *Your transaction with Reference ID \`${referenceId}\` has been marked as Paid.*\n\nThank you for using DirectPay!`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    logger.error(`Error marking transaction as paid: ${error.message}`);
    throw error;
  }
}

// -------- FUNCTION: CREATE PAYCREST ORDER --------
/**
 * Creates a Paycrest order to off-ramp crypto.
 * @param {string} userId        - The user's Telegram ID or unique identifier.
 * @param {number} amount        - The amount of the crypto token to off-ramp (crypto amount).
 * @param {string} token         - The token being off-ramped (e.g., "USDC" or "USDT").
 * @param {string} network       - The blockchain network name (e.g., "Base", "Polygon", "BNB Smart Chain").
 * @param {object} bankDetails   - Contains user’s bank info: { bankName, accountNumber, accountName, ... }.
 * @returns {object}             - The Paycrest order object, including an `id` and a `receiveAddress`.
 */
async function createPaycrestOrder(userId, amount, token, network, bankDetails) {
  try {
    // 1) Ensure the user’s bank exists in our bank list.
    const bankItem = bankList.find((b) => b.bankName.toLowerCase() === bankDetails.bankName.toLowerCase());
    if (!bankItem || !bankItem.paycrestCode) {
      throw new Error(`No Paycrest institution code found for bank: ${bankDetails.bankName}`);
    }

    // 2) Construct the recipient object using Paycrest’s required fields.
    const recipient = {
      institution: bankItem.paycrestCode,       // Paycrest institution code from your bank list
      accountIdentifier: bankDetails.accountNumber,
      accountName: bankDetails.accountName,
      memo: `Payment from DirectPay`,           // A custom note/memo
      providerId: ""                            // If you need a specific liquidity provider, otherwise empty
    };

    // 3) Get the appropriate exchange rate for this token from your global `exchangeRates` object.
    const rate = exchangeRates[token];
    if (!rate) {
      throw new Error(`Exchange rate for ${token} not found or zero.`);
    }

    // 4) Construct your Paycrest order payload. 
    const orderPayload = {
      amount: String(amount),                   // The amount of token to be off-ramped, in string format
      rate: String(rate),                       // The rate from token to NGN
      network: mapToPaycrestNetwork(network),    // Map "BNB Smart Chain" -> "bnb-smart-chain", etc.
      token: token.toUpperCase(),               // e.g., "USDC" or "USDT"
      recipient: recipient,
      returnAddress: PAYCREST_RETURN_ADDRESS,   // Return address if transaction fails
      feePercent: 2,                            // Example fee (2%)
      // feeAddress: '0x123...',                // Optionally specify a fee address if needed
    };

    // 5) Call Paycrest’s API to create the order.
    const orderResp = await axios.post('https://api.paycrest.io/v1/sender/orders', orderPayload, {
      headers: {
        'API-Key': PAYCREST_API_KEY,      // Your Paycrest Client ID / API key
        'Content-Type': 'application/json'
      }
    });

    // 6) Validate the response from Paycrest.
    if (orderResp.data.status !== 'success') {
      throw new Error(`Paycrest order creation failed: ${orderResp.data.message}`);
    }

    // 7) The returned `data` object should contain details like `id`, `amount`, `token`, `network`, `receiveAddress`, etc.
    return orderResp.data.data; 
  } catch (err) {
    logger.error(`Error creating Paycrest order for user ${userId}: ${err.message}`);
    throw new Error(`Failed to create Paycrest order. Details: ${err.message}`);
  }
}

/**
 * A helper function to map your internal chain/network naming (e.g., "BNB Smart Chain")
 * to what Paycrest expects (e.g., "bnb-smart-chain").
 */
function mapToPaycrestNetwork(chainName) {
  const lower = chainName.toLowerCase().trim();
  if (lower.includes('base')) return 'base';
  if (lower.includes('polygon')) return 'polygon';
  if (lower.includes('bnb')) return 'bnb-smart-chain';
  // Add more mappings if needed
  throw new Error(`Unsupported or unknown chain for Paycrest: ${chainName}`);
}

// -------- FUNCTION: WITHDRAW FROM BLOCKRADAR --------
async function withdrawFromBlockradar(chain, assetId, address, amount, reference, metadata) {
  try {
    const chainData = chains[chain];
    if (!chainData) {
      throw new Error(`Unsupported chain: ${chain}`);
    }

    const response = await axios.post(
      `https://api.blockradar.co/v1/wallets/${chainData.id}/withdraw`,
      {
        address,
        amount: String(amount),
        assetId,
        reference,
        metadata,
      },
      {
        headers: {
          'x-api-key': BLOCKRADAR_API_KEY,
          'Content-Type': 'application/json',
        },
      }
    );

    if (response.data.statusCode !== 200) {
      throw new Error(`Blockradar withdrawal error: ${JSON.stringify(response.data)}`);
    }

    return response.data;
  } catch (error) {
    logger.error(
      `Error withdrawing from Blockradar: ${error.response ? error.response.data.message : error.message}`
    );
    throw error;
  }
}

// -------- FUNCTION: DISPLAY TRANSACTIONS WITH PAGINATION (EDIT EXISTING MESSAGE) --------
async function displayTransactions(ctx, page = 1) {
  const userId = ctx.from.id.toString();
  let userState;

  try {
    userState = await getUserState(userId);
  } catch (error) {
    logger.error(`Error in displayTransactions: ${error.message}`);
    return ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
  }

  const snapshot = await db
    .collection('transactions')
    .where('userId', '==', userId)
    .orderBy('timestamp', 'desc')
    .get();

  if (snapshot.empty) {
    return ctx.replyWithMarkdown('💰 You have no transactions yet.');
  }

  const allTransactions = snapshot.docs.map((doc) => doc.data());
  const itemsPerPage = 5;
  const totalPages = Math.ceil(allTransactions.length / itemsPerPage);

  if (page < 1) page = 1;
  if (page > totalPages) page = totalPages;

  const startIdx = (page - 1) * itemsPerPage;
  const endIdx = page * itemsPerPage;
  const transactionsPage = allTransactions.slice(startIdx, endIdx);

  let txMsg = `💰 *Your Transactions (Page ${page} of ${totalPages})*\n\n`;
  transactionsPage.forEach((tx) => {
    txMsg += `• *Reference ID:* \`${tx.referenceId || 'N/A'}\`\n  • *Amount:* ${tx.amount || 'N/A'} ${tx.asset || 'N/A'}\n  • *Status:* ${tx.status || 'Pending'}\n  • *Date:* ${
      tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'
    }\n\n`;
  });

  const navigationButtons = [];
  if (page > 1) navigationButtons.push(Markup.button.callback('⏮ Previous', `tx_page_${page - 1}`));
  if (page < totalPages) navigationButtons.push(Markup.button.callback('Next ⏭', `tx_page_${page + 1}`));
  navigationButtons.push(Markup.button.callback('🔙 Main Menu', 'back_to_main_menu'));

  try {
    await ctx.editMessageText(txMsg, {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([navigationButtons]).reply_markup,
    });
  } catch (error) {
    // If message can't be edited (e.g., too old), send a new one
    await ctx.replyWithMarkdown(txMsg, Markup.inlineKeyboard([navigationButtons]));
  }
}

// -------- FUNCTION: DISPLAY WALLETS WITH PAGINATION --------
async function displayWallets(ctx, page = 1) {
  const userId = ctx.from.id.toString();
  let userState;
  
  try {
    userState = await getUserState(userId);
  } catch (error) {
    logger.error(`Error in displayWallets: ${error.message}`);
    return ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
  }

  const wallets = userState.wallets;
  const itemsPerPage = 5;
  const totalPages = Math.ceil(wallets.length / itemsPerPage);

  if (page < 1) page = 1;
  if (page > totalPages) page = totalPages;

  const startIdx = (page - 1) * itemsPerPage;
  const endIdx = page * itemsPerPage;
  const walletsPage = wallets.slice(startIdx, endIdx);

  let walletMsg = `💼 *Your Wallets (Page ${page} of ${totalPages})*\n\n`;
  walletsPage.forEach((wallet, index) => {
    walletMsg += `• *Wallet ${startIdx + index + 1}:*\n  • *Chain:* ${wallet.chain}\n  • *Address:* \`${wallet.address}\`\n  • *Bank Linked:* ${wallet.bank ? '✅ Yes' : '❌ No'}\n\n`;
  });

  const navigationButtons = [];
  if (page > 1) navigationButtons.push(Markup.button.callback('⏮ Previous', `wallet_page_${page - 1}`));
  if (page < totalPages) navigationButtons.push(Markup.button.callback('Next ⏭', `wallet_page_${page + 1}`));
  navigationButtons.push(Markup.button.callback('🔙 Main Menu', 'back_to_main_menu'));

  await ctx.replyWithMarkdown(walletMsg, Markup.inlineKeyboard([navigationButtons]));
}

// -------- SUPPORT HANDLER --------
bot.hears(/ℹ️\s*Support/i, async (ctx) => {
  await ctx.replyWithMarkdown(
    '🛠️ *Support Menu*\n\nHow can we assist you today?',
    Markup.inlineKeyboard([
      [Markup.button.callback('❓ How It Works', 'support_how_it_works')],
      [Markup.button.callback('⚠️ Transaction Not Received', 'support_tx_not_received')],
      [Markup.button.callback('💬 Contact Support', 'support_contact')],
    ])
  );
});

// -------- ACTION HANDLERS: SUPPORT --------
bot.action('support_how_it_works', async (ctx) => {
  await ctx.answerCbQuery();
  const howItWorksMsg = `📘 *How DirectPay Works*\n\n1. *Generate Your Wallet*: Create a dedicated wallet on your chosen blockchain.\n2. *Link Your Bank Account*: Connect your bank for seamless fiat transactions.\n3. *Deposit Stablecoins*: Send USDC or USDT to your wallet.\n4. *Automatic Conversion*: We convert your stablecoins to NGN at competitive rates.\n5. *Instant Payout*: Receive the converted amount directly in your bank account.\n\nFor more details, refer to our [documentation](https://your-docs-link.com).`;
  try {
    await ctx.editMessageText(howItWorksMsg, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Support Menu', 'back_to_support_menu')],
      ]).reply_markup,
    });
  } catch (error) {
    // If message can't be edited (e.g., too old), send a new one
    await ctx.replyWithMarkdown(howItWorksMsg, Markup.inlineKeyboard([
      [Markup.button.callback('🔙 Support Menu', 'back_to_support_menu')],
    ]));
  }
});

bot.action('support_tx_not_received', async (ctx) => {
  await ctx.answerCbQuery();
  const txIssueMsg = `⚠️ *Transaction Not Received*\n\nIf you haven't received your payout, please check the following:\n\n• Ensure the deposit transaction is confirmed on the blockchain.\n• Verify your bank account details are correct.\n• Check the transaction status in the "💰 Transactions" section.\n\nIf the issue persists, contact our support team for assistance.`;
  try {
    await ctx.editMessageText(txIssueMsg, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Support Menu', 'back_to_support_menu')],
      ]).reply_markup,
    });
  } catch (error) {
    await ctx.replyWithMarkdown(txIssueMsg, Markup.inlineKeyboard([
      [Markup.button.callback('🔙 Support Menu', 'back_to_support_menu')],
    ]));
  }
});

bot.action('support_contact', async (ctx) => {
  await ctx.answerCbQuery();
  const contactMsg = `💬 *Contact Support*\n\nYou can reach our support team at [@your_support_username](https://t.me/your_support_username) for any assistance or queries.`;
  try {
    await ctx.editMessageText(contactMsg, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Support Menu', 'back_to_support_menu')],
      ]).reply_markup,
    });
  } catch (error) {
    await ctx.replyWithMarkdown(contactMsg, Markup.inlineKeyboard([
      [Markup.button.callback('🔙 Support Menu', 'back_to_support_menu')],
    ]));
  }
});

// -------- ACTION HANDLER: BACK TO SUPPORT MENU --------
bot.action('back_to_support_menu', async (ctx) => {
  await ctx.answerCbQuery();
  const supportMenuMsg = '🛠️ *Support Menu*\n\nHow can we assist you today?';
  try {
    await ctx.editMessageText(supportMenuMsg, {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('❓ How It Works', 'support_how_it_works')],
        [Markup.button.callback('⚠️ Transaction Not Received', 'support_tx_not_received')],
        [Markup.button.callback('💬 Contact Support', 'support_contact')],
      ]).reply_markup,
    });
  } catch (error) {
    await ctx.replyWithMarkdown(supportMenuMsg, Markup.inlineKeyboard([
      [Markup.button.callback('❓ How It Works', 'support_how_it_works')],
      [Markup.button.callback('⚠️ Transaction Not Received', 'support_tx_not_received')],
      [Markup.button.callback('💬 Contact Support', 'support_contact')],
    ]));
  }
});

// -------- LEARN ABOUT BASE HANDLER --------
const baseContent = [
  {
    title: 'Welcome to Base',
    text: 'Base is a secure, low-cost blockchain solution that powers DirectPay’s multi-chain wallets. It ensures fast and reliable transactions for all your crypto needs.',
  },
  {
    title: 'Why Choose Base?',
    text: '- **Low Fees**: Save more with minimal transaction costs.\n- **Fast Transactions**: Experience near-instant transfers.\n- **Security**: Advanced security protocols to protect your assets.',
  },
  {
    title: 'Getting Started',
    text: 'To start using Base, simply generate a wallet on your preferred blockchain (Base, Polygon, or BNB Smart Chain), link your bank account, and begin transacting seamlessly.',
  },
  {
    title: 'Learn More',
    text: 'Visit the official documentation at [Base Docs](https://base-docs-link.com) for comprehensive guides and support.',
  },
];

async function sendBaseContent(ctx, index, isNew = false) {
  const content = baseContent[index];
  const totalPages = baseContent.length;

  const navigationButtons = [];
  if (index > 0) {
    navigationButtons.push(Markup.button.callback('⬅️ Previous', `base_page_${index - 1}`));
  }
  if (index < totalPages - 1) {
    navigationButtons.push(Markup.button.callback('Next ➡️', `base_page_${index + 1}`));
  }
  navigationButtons.push(Markup.button.callback('🔚 Exit', 'exit_base'));

  const inlineKeyboard = Markup.inlineKeyboard([navigationButtons]);

  if (isNew) {
    const sentMessage = await ctx.replyWithMarkdown(
      `**${content.title}**\n\n${content.text}`,
      inlineKeyboard
    );
    ctx.session.baseMessageId = sentMessage.message_id;
  } else {
    try {
      await ctx.editMessageText(`**${content.title}**\n\n${content.text}`, {
        parse_mode: 'Markdown',
        reply_markup: inlineKeyboard.reply_markup,
      });
    } catch (error) {
      // If the message can't be edited (e.g., too old), send a new one
      const sentMessage = await ctx.replyWithMarkdown(
        `**${content.title}**\n\n${content.text}`,
        inlineKeyboard
      );
      ctx.session.baseMessageId = sentMessage.message_id;
    }
  }

  // Optional: Delete the message after a certain time to keep chat clean
  setTimeout(() => {
    if (ctx.session.baseMessageId) {
      ctx.deleteMessage(ctx.session.baseMessageId).catch(() => {});
      ctx.session.baseMessageId = null;
    }
  }, 120000); // 2 minutes
}

bot.hears(/📘\s*Learn About Base/i, async (ctx) => {
  await sendBaseContent(ctx, 0, true);
});

// -------- ACTION HANDLER: LEARN ABOUT BASE PAGES --------
bot.action(/base_page_(\d+)/, async (ctx) => {
  const page = parseInt(ctx.match[1], 10);
  if (isNaN(page) || page < 0 || page >= baseContent.length) {
    await ctx.answerCbQuery('⚠️ Invalid page number.', { show_alert: true });
    return;
  }
  await sendBaseContent(ctx, page);
  await ctx.answerCbQuery();
});

// -------- ACTION HANDLER: EXIT BASE LEARN MORE --------
bot.action('exit_base', async (ctx) => {
  await ctx.answerCbQuery();
  if (ctx.session.baseMessageId) {
    await ctx.deleteMessage(ctx.session.baseMessageId).catch(() => {});
    ctx.session.baseMessageId = null;
  }
  await ctx.replyWithMarkdown('🔚 You have exited the "Learn About Base" section.', getMainMenu(true, true));
});

// -------- ACTION HANDLER: BACK TO MAIN MENU --------
bot.action('back_to_main_menu', async (ctx) => {
  await ctx.answerCbQuery();
  await greetUser(ctx);
  try {
    await ctx.deleteMessage();
  } catch (error) {
    // Message might have already been deleted
  }
});

// -------- ADMIN PANEL HANDLERS (PLACEHOLDERS) --------
bot.action('admin_view_transactions', async (ctx) => {
  await ctx.answerCbQuery();
  // Placeholder: Implement viewing all transactions
  await ctx.replyWithMarkdown('📋 *View All Transactions*\n\nFeature under development.');
});

bot.action('admin_send_message', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session.sendMessageMode = true;
  await ctx.replyWithMarkdown('📩 *Send Message to User*\n\nPlease enter the User ID you want to message:');
});

bot.action('admin_mark_paid', async (ctx) => {
  await ctx.answerCbQuery();
  // Placeholder: Implement marking transactions as paid
  await ctx.replyWithMarkdown('✅ *Mark Transactions as Paid*\n\nPlease enter the Reference ID of the transaction to mark as paid:');
  ctx.session.markPaidMode = true;
});

bot.action('admin_view_users', async (ctx) => {
  await ctx.answerCbQuery();
  // Placeholder: Implement viewing all users
  await ctx.replyWithMarkdown('👥 *View All Users*\n\nFeature under development.');
});

bot.action('admin_broadcast_message', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session.broadcastMode = true;
  await ctx.replyWithMarkdown('📢 *Broadcast Message*\n\nPlease enter the message you want to broadcast to all users:');
});

bot.action('admin_manage_banks', async (ctx) => {
  await ctx.answerCbQuery();
  // Placeholder: Implement managing banks
  await ctx.replyWithMarkdown('🏦 *Manage Banks*\n\nFeature under development.');
});

// -------- SEND MESSAGE SCENE --------
sendMessageScene.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();

  if (ctx.session.sendMessageMode) {
    const targetUserId = ctx.message.text.trim();
    if (!/^\d+$/.test(targetUserId)) {
      return ctx.replyWithMarkdown('❌ Invalid User ID. Please enter a numeric User ID:');
    }

    // Check if user exists
    const userDoc = await db.collection('users').doc(targetUserId).get();
    if (!userDoc.exists) {
      return ctx.replyWithMarkdown('❌ User not found. Please enter a valid User ID:');
    }

    ctx.session.targetUserId = targetUserId;
    ctx.session.sendMessageMode = false;
    ctx.session.awaitingMessage = true;

    await ctx.replyWithMarkdown('📝 Enter the message you want to send to the user:');
  } else if (ctx.session.broadcastMode) {
    const broadcastMsg = ctx.message.text.trim();
    if (!broadcastMsg) {
      return ctx.replyWithMarkdown('❌ Message cannot be empty. Please enter a valid message:');
    }

    // Fetch all user IDs
    const usersSnapshot = await db.collection('users').get();
    const allUserIds = usersSnapshot.docs.map((doc) => doc.id);

    // Send message to each user
    for (const uid of allUserIds) {
      try {
        await bot.telegram.sendMessage(uid, `📢 *Broadcast Message from Admin:*\n\n${broadcastMsg}`, {
          parse_mode: 'Markdown',
        });
      } catch (error) {
        logger.error(`Failed to send broadcast to ${uid}: ${error.message}`);
      }
    }

    await ctx.replyWithMarkdown('📢 Broadcast message sent to all users.');
    ctx.session.broadcastMode = false;
    await ctx.replyWithMarkdown('👨‍💼 *Admin Panel*\n\nSelect an option below:', getAdminMenu());
  }
});

sendMessageScene.leave((ctx) => {
  delete ctx.session.targetUserId;
  delete ctx.session.awaitingUserId;
  delete ctx.session.awaitingBroadcast;
  delete ctx.session.awaitingMessage;
});

// -------- SEND MESSAGE AFTER ADMIN SENDS TEXT --------
bot.on('message', async (ctx) => {
  const userId = ctx.from.id.toString();

  if (ctx.session.targetUserId && ctx.session.awaitingMessage) {
    const messageContent = ctx.message.text.trim();
    const targetUserId = ctx.session.targetUserId;

    try {
      await bot.telegram.sendMessage(
        targetUserId,
        `📩 *Message from Admin:*\n\n${messageContent}`,
        { parse_mode: 'Markdown' }
      );
      await ctx.replyWithMarkdown('✅ Message sent successfully.');
    } catch (error) {
      logger.error(`Error sending message to ${targetUserId}: ${error.message}`);
      await ctx.replyWithMarkdown('⚠️ Failed to send the message. The user might have blocked the bot.');
    }

    // Cleanup
    delete ctx.session.targetUserId;
    delete ctx.session.awaitingMessage;
    ctx.scene.leave();
  }

  if (ctx.session.markPaidMode) {
    const referenceId = ctx.message.text.trim();
    if (!referenceId) {
      return ctx.replyWithMarkdown('❌ Reference ID cannot be empty. Please enter a valid Reference ID:');
    }

    try {
      await markTransactionAsPaid(referenceId);
      await ctx.replyWithMarkdown(`✅ Transaction \`${referenceId}\` has been marked as *Paid*.`);
    } catch (error) {
      await ctx.replyWithMarkdown(`⚠️ Failed to mark transaction as paid: ${error.message}`);
    }

    // Cleanup
    delete ctx.session.markPaidMode;
  }

  // Add additional handlers if necessary
});

// -------- ACTION HANDLER: GENERATE WALLET FROM VIEW WALLET --------
bot.action('view_wallet_generate', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.replyWithMarkdown(
    '🔐 *Wallet Generation*\n\nPlease select the blockchain network where you want to generate your wallet:',
    Markup.inlineKeyboard([
      [Markup.button.callback('Base', 'generate_wallet_Base')],
      [Markup.button.callback('Polygon', 'generate_wallet_Polygon')],
      [Markup.button.callback('BNB Smart Chain', 'generate_wallet_BNB Smart Chain')],
    ])
  );
});

// -------- FUNCTION: MARK TRANSACTION AS PAID --------
async function markTransactionAsPaid(referenceId) {
  try {
    const txDoc = await db.collection('transactions').doc(referenceId).get();
    if (!txDoc.exists) {
      throw new Error('Transaction not found.');
    }

    await db.collection('transactions').doc(referenceId).update({
      status: 'Paid',
      paidAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Notify user
    const txData = txDoc.data();
    await bot.telegram.sendMessage(
      txData.userId,
      `✅ *Your transaction with Reference ID \`${referenceId}\` has been marked as Paid.*\n\nThank you for using DirectPay!`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    logger.error(`Error marking transaction as paid: ${error.message}`);
    throw error;
  }
}

// -------- WEBHOOK HANDLERS --------

// Function to verify Paycrest webhook signature
function verifyPaycrestSignature(requestBody, signatureHeader, secretKey) {
  const expectedSignature = crypto
    .createHmac('sha256', Buffer.from(secretKey))
    .update(requestBody)
    .digest('hex');
  return signatureHeader === expectedSignature;
}

// Webhook for Blockradar
app.post('/webhook/blockradar', async (req, res) => {
  try {
    const event = req.body;
    logger.info(`Received Blockradar webhook: ${JSON.stringify(event)}`);

    // Log the event for auditing
    fs.appendFileSync(
      path.join(__dirname, 'webhook_logs.txt'),
      `${new Date().toISOString()} - Blockradar: ${JSON.stringify(event, null, 2)}\n`
    );

    // Handle specific event types (e.g., deposit.success)
    if (event.type === 'deposit.success') {
      const { userId, amount, asset, referenceId, network } = event.data;

      // Find the wallet for the user
      const userDoc = await db.collection('users').doc(userId).get();
      if (!userDoc.exists) {
        logger.error(`User ${userId} not found for deposit.`);
        return res.status(400).send('User not found.');
      }

      const userData = userDoc.data();
      const wallet = userData.wallets.find((w) => w.supportedAssets.includes(asset));
      if (!wallet) {
        logger.error(`No wallet found for user ${userId} supporting asset ${asset}.`);
        return res.status(400).send('Wallet not found.');
      }

      // Create a Paycrest order
      const paycrestOrder = await createPaycrestOrder(userId, amount, asset, network, wallet.bank);
      if (!paycrestOrder) {
        throw new Error('Failed to create Paycrest order.');
      }

      // Withdraw from Blockradar to Paycrest's address
      await withdrawFromBlockradar(
        network,
        asset,
        PAYCREST_RETURN_ADDRESS,
        amount,
        paycrestOrder.id,
        { userId, referenceId }
      );

      // Store transaction in Firestore
      await db.collection('transactions').doc(paycrestOrder.id).set({
        userId,
        referenceId: paycrestOrder.id,
        amount,
        asset,
        status: 'Pending',
        chain: network,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Notify user
      await bot.telegram.sendMessage(
        userId,
        `✅ *Deposit Received*\n\n• *Amount:* ${amount} ${asset}\n• *Reference ID:* \`${paycrestOrder.id}\`\n• *Status:* Pending\n\nWe are processing your payout. You will receive the NGN equivalent shortly.`,
        { parse_mode: 'Markdown' }
      );

      // Provide contextual FAQ after deposit
      await bot.telegram.sendMessage(
        userId,
        `📢 *What's Next?*\n\nYour deposit is being processed. Here's what you can expect:\n• *Conversion:* We convert your ${asset} to NGN at competitive rates.\n• *Payout:* The converted amount will be sent directly to your linked bank account.\n\nFor more details, type "ℹ️ Support" or visit our [Support Page](https://your-support-link.com).`,
        { parse_mode: 'Markdown', disable_web_page_preview: true }
      );
    }

    // Add more event handlers as needed

    res.status(200).send('OK');
  } catch (error) {
    logger.error(`Error processing Blockradar webhook: ${error.message}`);
    res.status(500).send('Error');
  }
});

// Webhook for Paycrest
app.post('/webhook/paycrest', async (req, res) => {
  const signature = req.headers['x-paycrest-signature'];
  const rawBody = JSON.stringify(req.body);

  if (!verifyPaycrestSignature(rawBody, signature, PAYCREST_CLIENT_SECRET)) {
    logger.error('Invalid Paycrest signature.');
    return res.status(401).send('Invalid signature.');
  }

  try {
    const event = req.body.event;
    const data = req.body.data;

    logger.info(`Received Paycrest webhook: ${JSON.stringify(event)}`);

    // Handle specific event types
    if (event === 'payment_order.settled') {
      const { referenceId } = data;

      // Update transaction status to 'Paid'
      const txDoc = await db.collection('transactions').doc(referenceId).get();
      if (!txDoc.exists) {
        logger.error(`Transaction ${referenceId} not found for Paycrest settlement.`);
        return res.status(400).send('Transaction not found.');
      }

      await db.collection('transactions').doc(referenceId).update({
        status: 'Paid',
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      const txData = txDoc.data();

      // Notify user
      await bot.telegram.sendMessage(
        txData.userId,
        `✅ *Payout Completed*\n\n• *Reference ID:* \`${referenceId}\`\n• *Amount:* ₦${txData.amount}\n• *Status:* Paid\n\nThank you for using DirectPay!`,
        { parse_mode: 'Markdown' }
      );
    }

    // Add more event handlers as needed

    res.status(200).send('OK');
  } catch (error) {
    logger.error(`Error processing Paycrest webhook: ${error.message}`);
    res.status(500).send('Error');
  }
});

// -------- TELEGRAM WEBHOOK SETUP --------
(async () => {
  try {
    await bot.telegram.setWebhook(TELEGRAM_WEBHOOK_URL);
    logger.info(`Telegram webhook set to: ${TELEGRAM_WEBHOOK_URL}`);
  } catch (error) {
    logger.error(`Failed to set Telegram webhook: ${error.message}`);
    process.exit(1);
  }
})();

// -------- EXPRESS ROUTE FOR TELEGRAM WEBHOOK --------
app.post(TELEGRAM_WEBHOOK_PATH, (req, res) => {
  bot.handleUpdate(req.body, res);
});

// -------- START EXPRESS SERVER --------
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  logger.info(`Webhook server running on port ${PORT}`);
});

// -------- GRACEFUL SHUTDOWN --------
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
