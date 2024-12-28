// =================== Import Dependencies ===================
const express = require('express');
const { Telegraf, Markup, Scenes, session } = require('telegraf');
const admin = require('firebase-admin');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const winston = require('winston');
const Bottleneck = require('bottleneck');
require('dotenv').config();

// =================== Logger Setup ===================
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(
      ({ timestamp, level, message }) => `[${timestamp}] ${level.toUpperCase()}: ${message}`
    )
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'bot.log', maxsize: 5242880, maxFiles: 5 })
  ],
});

// =================== Firebase Setup ===================
const serviceAccount = require('./directpay.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://directpay9ja.firebaseio.com"
});
const db = admin.firestore();

// =================== Configuration & API Keys ===================
const BOT_TOKEN = process.env.BOT_TOKEN;
const PAYCREST_API_KEY = process.env.PAYCREST_API_KEY;
const PAYCREST_CLIENT_SECRET = process.env.PAYCREST_CLIENT_SECRET;
const PAYCREST_RATE_API_URL = process.env.PAYCREST_RATE_API_URL || 'https://api.paycrest.io/v1/rates';
const PAYCREST_RETURN_ADDRESS = process.env.PAYCREST_RETURN_ADDRESS || "0xYourReturnAddressHere";
const PERSONAL_CHAT_ID = process.env.PERSONAL_CHAT_ID;
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => id.trim()) : [];
const MAX_WALLETS = 5;
const PAYSTACK_API_KEY = process.env.PAYSTACK_API_KEY;

const TELEGRAM_WEBHOOK_PATH = process.env.TELEGRAM_WEBHOOK_PATH || '/webhook/telegram';
const TELEGRAM_WEBHOOK_URL = `${WEBHOOK_DOMAIN}${TELEGRAM_WEBHOOK_PATH}`;

// =================== Blockradar API Keys Mapping ===================
const BLOCKRADAR_API_KEYS = {
  'Base': process.env.BLOCKRADAR_BASE_API_KEY,
  'BNB Smart Chain': process.env.BLOCKRADAR_BNB_API_KEY,
  'Polygon': process.env.BLOCKRADAR_POLYGON_API_KEY,
};

// =================== Supported Assets ===================
const SUPPORTED_ASSETS = ['USDC', 'USDT'];

// =================== Exchange Rates (Dynamic) ===================
let exchangeRates = {
  USDC: 0,
  USDT: 0
};

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
  }
}

fetchExchangeRates();
setInterval(fetchExchangeRates, 300000); // 5 minutes

// =================== Multi-Chain Wallet Configuration with Asset IDs ===================
const chains = {
  Base: {
    id: 'e31c44d6-0344-4ee1-bcd1-c88e89a9e3f1',
    key: 'i76FL4yzaRuYXPUzskM0Piodo5r08iJ1FUTgpuiylSDqYIVlcdEcPv5df3kbTvw',
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
    key: '4AHpp8GveWieZ5XfBCRot9TxGZIZHJUGJ1jBIrK2WckIupIMPXvfId8y5mhND',
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
    key: '8nV6cYb7UE37DZrTNIyu1mVCLvWR7Pp3GfYt6WqxBUsQVZtTlx4rCdbHKDFMM',
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

const chainMapping = {
  'base': 'Base',
  'polygon': 'Polygon',
  'bnb smart chain': 'BNB Smart Chain',
  'bnb smartchain': 'BNB Smart Chain',
  'bnb chain': 'BNB Smart Chain',
  'bnb': 'BNB Smart Chain',
};

// =================== Initialize Express App for Webhooks ===================
const app = express();
app.use(express.json());

// =================== Initialize Telegraf Bot with Session and Stage Middleware ===================
const bot = new Telegraf(BOT_TOKEN);

const stage = new Scenes.Stage();
const bankLinkingScene = new Scenes.BaseScene('bank_linking_scene');
const sendMessageScene = new Scenes.BaseScene('send_message_scene');
stage.register(bankLinkingScene, sendMessageScene);
bot.use(session());
bot.use(stage.middleware());

// =================== Updated Bank List with Paycrest Institution Codes ===================
const bankList = [
  { name: 'Access Bank', code: '044', aliases: ['access', 'access bank', 'accessb', 'access bank nigeria'], paycrestInstitutionCode: 'ABNGNGLA' },
  { name: 'Zenith Bank', code: '057', aliases: ['zenith', 'zenith bank', 'zenithb', 'zenith bank nigeria'], paycrestInstitutionCode: 'ZINNGNGLA' },
  { name: 'GTBank', code: '058', aliases: ['gtbank', 'gt bank', 'gtb', 'gt bank nigeria'], paycrestInstitutionCode: 'GTBNGNGLA' },
  { name: 'First Bank', code: '011', aliases: ['first bank', 'firstbank', 'first bank nigeria'], paycrestInstitutionCode: 'FBGNGLA' },
  { name: 'UBA', code: '033', aliases: ['uba', 'united bank for africa', 'united bank for africa nigeria'], paycrestInstitutionCode: 'UBANGNGLA' },
  { name: 'Ecobank', code: '050', aliases: ['ecobank', 'ecobank nigeria'], paycrestInstitutionCode: 'ECOBNGNGLA' },
  { name: 'Fidelity Bank', code: '070', aliases: ['fidelity', 'fidelity bank', 'fidelityb', 'fidelity bank nigeria'], paycrestInstitutionCode: 'FIDBNGNGLA' },
  { name: 'Union Bank', code: '032', aliases: ['union bank', 'unionbank', 'union bank nigeria'], paycrestInstitutionCode: 'UNBNGNGLA' },
  { name: 'Stanbic IBTC', code: '221', aliases: ['stanbic ibtc', 'stanbicibtc', 'stanbic ibtc nigeria'], paycrestInstitutionCode: 'SBICNGPC' },
  { name: 'Sterling Bank', code: '232', aliases: ['sterling bank', 'sterlingbank', 'sterling bank nigeria'], paycrestInstitutionCode: 'STRBNGNGLA' },
  { name: 'Jaiz Bank', code: '301', aliases: ['jaiz bank', 'jaizbank', 'jaiz bank nigeria'], paycrestInstitutionCode: 'JAIZNGPC' },
  { name: 'Wema Bank', code: '035', aliases: ['wema', 'wema bank', 'wemab', 'wema bank nigeria'], paycrestInstitutionCode: 'WEMANGLA' },
  { name: 'Kuda Microfinance Bank', code: '50211', aliases: ['kuda', 'kuda bank', 'kudab', 'kuda bank nigeria'], paycrestInstitutionCode: 'KUDANGPC' },
  { name: 'OPay', code: '999992', aliases: ['opay', 'opay nigeria'], paycrestInstitutionCode: 'OPAYNGPC' },
  { name: 'PalmPay', code: '999991', aliases: ['palmpay', 'palmpay nigeria'], paycrestInstitutionCode: 'PALMNGPC' },
  { name: 'Paystack-Titan MFB', code: '999992', aliases: ['paystack', 'paystack mfb', 'paystack-titan mfb'], paycrestInstitutionCode: 'PAYTNGPC' },
  { name: 'Moniepoint MFB', code: '999993', aliases: ['moniepoint', 'moniepoint mfb', 'moniepoint nigeria'], paycrestInstitutionCode: 'MONINGPC' },
  { name: 'Safe Haven MFB', code: '999994', aliases: ['safe haven', 'safe haven mfb', 'safe haven nigeria'], paycrestInstitutionCode: 'SAHVNGPC' }
];

// =================== Verify Bank Account with Paystack ===================
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

// =================== Calculate Payout Based on Asset Type ===================
function calculatePayout(asset, amount) {
  const rate = exchangeRates[asset];
  if (!rate) {
    throw new Error(`Unsupported asset received: ${asset}`);
  }
  return (amount * rate).toFixed(2);
}

// =================== Generate a Unique Reference ID for Transactions ===================
function generateReferenceId() {
  return 'REF-' + Math.random().toString(36).substr(2, 9).toUpperCase();
}

// =================== Define Menus ===================
const getMainMenu = (walletExists, hasBankLinked) =>
  Markup.keyboard([
    [walletExists ? '💼 View Wallet' : '💼 Generate Wallet', hasBankLinked ? '⚙️ Settings' : '🏦 Link Bank Account'],
    ['💰 Transactions', 'ℹ️ Support', '📘 Learn About Base'],
    ['📈 View Current Rates'],
  ]).resize();

const getSettingsMenu = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Generate New Wallet', 'settings_generate_wallet')],
    [Markup.button.callback('✏️ Edit Linked Bank Details', 'settings_edit_bank')],
    [Markup.button.callback('💬 Support', 'settings_support')],
    [Markup.button.callback('🧾 Generate Transaction Receipt', 'settings_generate_receipt')],
    [Markup.button.callback('🔙 Back to Main Menu', 'settings_back_to_main')],
  ]);

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

// =================== Logging Helper Function ===================
async function logUserAction(user, action, details) {
  const message = `📝 *User Action Log*\n\n` +
                  `*Username:* @${user.username || 'N/A'}\n` +
                  `*User ID:* ${user.id}\n` +
                  `*First Name:* ${user.first_name || 'N/A'}\n` +
                  `*Last Name:* ${user.last_name || 'N/A'}\n` +
                  `*Action:* ${action}\n` +
                  `*Details:* ${details}\n` +
                  `*Timestamp:* ${new Date().toLocaleString()}`;
  
  try {
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, message, { parse_mode: 'Markdown' });
    logger.info(`Logged action for user ${user.id}: ${action}`);
  } catch (error) {
    logger.error(`Failed to send log to admin for user ${user.id}: ${error.message}`);
  }
}

// =================== Firestore Helper Functions ===================
async function getUserState(userId) {
  try {
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      await db.collection('users').doc(userId).set({
        firstName: ctx.from.first_name || 'Valued User',
        wallets: [],
        walletAddresses: [],
        hasReceivedDeposit: false,
        awaitingBroadcastMessage: false,
      });
      return {
        firstName: ctx.from.first_name || 'Valued User',
        wallets: [],
        walletAddresses: [],
        hasReceivedDeposit: false,
        awaitingBroadcastMessage: false,
      };
    } else {
      const data = userDoc.data();
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

// =================== Greet User ===================
async function greetUser(ctx) {
  const userId = ctx.from.id.toString();
  let userState;
  try {
    userState = await getUserState(userId);
    logger.info(`Fetched user state for user ${userId}`);

    if (!userState.firstName) {
      await db.collection('users').doc(userId).set({
        firstName: ctx.from.first_name || 'Valued User'
      }, { merge: true });
      userState.firstName = ctx.from.first_name || 'Valued User';
      
      await logUserAction(ctx.from, 'First Interaction', 'User started the bot for the first time.');
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
    try {
      const sentMessage = await ctx.replyWithMarkdown(greeting, Markup.inlineKeyboard([
        [Markup.button.callback('🔧 Admin Panel', 'open_admin_panel')],
      ]));
      ctx.session.adminMessageId = sentMessage.message_id;
      
      await logUserAction(ctx.from, 'View Greeting', 'Admin accessed the greeting message.');
    } catch (error) {
      logger.error(`Error sending admin greeting to user ${userId}: ${error.message}`);
      await ctx.replyWithMarkdown('⚠️ An error occurred while sending your greeting. Please try again later.');
    }
  } else {
    try {
      await ctx.replyWithMarkdown(greeting, getMainMenu(walletExists, hasBankLinked));
      
      await logUserAction(ctx.from, 'View Greeting', `Wallet Exists: ${walletExists}, Bank Linked: ${hasBankLinked}`);
    } catch (error) {
      logger.error(`Error sending greeting to user ${userId}: ${error.message}`);
      await ctx.replyWithMarkdown('⚠️ An error occurred while sending your greeting. Please try again later.');
    }
  }
}

// =================== Handle /start Command ===================
bot.start(async (ctx) => {
  try {
    logger.info(`Received /start command from user ${ctx.from.id}`);
    await greetUser(ctx);
  } catch (error) {
    logger.error(`Error in /start command: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
  }
});

// =================== Generate Wallet Function ===================
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

// =================== Map Chain/Asset to Paycrest Network/Token ===================
function mapToPaycrest(asset, chainName) {
  if (!SUPPORTED_ASSETS.includes(asset)) return null;

  let token = asset.toUpperCase();
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

// =================== Define Scenes ===================

// ===== Bank Linking Scene =====
bankLinkingScene.enter(async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = ctx.session.walletIndex;

  if (walletIndex === undefined || walletIndex === null) {
    await ctx.replyWithMarkdown('⚠️ No wallet selected for linking. Please generate a wallet first using the "💼 Generate Wallet" option.');
    
    await logUserAction(ctx.from, 'Bank Linking Entered', 'No wallet selected.');
    
    ctx.scene.leave();
    return;
  }

  ctx.session.isBankLinking = true;
  ctx.session.bankData = {};
  ctx.session.bankData.step = 1;
  await ctx.replyWithMarkdown('🏦 Please enter your bank name (e.g., Access Bank):');
  
  await logUserAction(ctx.from, 'Start Bank Linking', `Selected Wallet Index: ${walletIndex}`);

  ctx.session.bankLinkingTimeout = setTimeout(() => {
    if (ctx.session.isBankLinking) {
      ctx.replyWithMarkdown('⏰ Bank linking process timed out due to inactivity. Please start again if you wish to link a bank account.');
      ctx.scene.leave();
    }
  }, 300000); // 5 minutes timeout
});

bankLinkingScene.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const input = ctx.message.text.trim();

  if (ctx.session.bankLinkingTimeout) {
    clearTimeout(ctx.session.bankLinkingTimeout);
  }

  if (ctx.session.bankData.step === 1) {
    const bankNameInput = input.toLowerCase();
    const bank = bankList.find((b) => b.aliases.includes(bankNameInput));

    if (!bank) {
      await ctx.replyWithMarkdown('❌ Invalid bank name. Please enter a valid bank name from our supported list:\n\n' + bankList.map(b => `• ${b.name}`).join('\n'));
      
      await logUserAction(ctx.from, 'Invalid Bank Name', `Entered Bank Name: ${input}`);
      return;
    }

    ctx.session.bankData.bankName = bank.name;
    ctx.session.bankData.bankCode = bank.code;
    ctx.session.bankData.step = 2;

    await ctx.replyWithMarkdown('🔢 Please enter your 10-digit bank account number:');
    
    ctx.session.bankLinkingTimeout = setTimeout(() => {
      if (ctx.session.isBankLinking) {
        ctx.replyWithMarkdown('⏰ Bank linking process timed out due to inactivity. Please start again if you wish to link a bank account.');
        ctx.scene.leave();
      }
    }, 300000); // 5 minutes timeout
  } else if (ctx.session.bankData.step === 2) {
    if (!/^\d{10}$/.test(input)) {
      await ctx.replyWithMarkdown('❌ Invalid account number. Please enter a valid 10-digit account number:');
      
      await logUserAction(ctx.from, 'Invalid Account Number', `Entered Account Number: ${input}`);
      return;
    }

    ctx.session.bankData.accountNumber = input;
    ctx.session.bankData.step = 3;

    await ctx.replyWithMarkdown('🔄 Verifying your bank details...');

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
      ctx.session.bankData.step = 4;

      await ctx.replyWithMarkdown(
        `🏦 *Bank Account Verification*\n\n` +
        `Please confirm your bank details:\n` +
        `- *Bank Name:* ${ctx.session.bankData.bankName}\n` +
        `- *Account Number:* ${ctx.session.bankData.accountNumber}\n` +
        `- *Account Holder:* ${accountName}\n\n` +
        `Is this information correct?`,
        Markup.inlineKeyboard([
          [Markup.button.callback('✅ Yes, Confirm', 'confirm_bank_yes')],
          [Markup.button.callback('❌ No, Edit Details', 'confirm_bank_no')],
          [Markup.button.callback('❌ Cancel Linking', 'cancel_bank_linking')],
        ])
      );

      await logUserAction(ctx.from, 'Bank Verification Success', `Bank: ${ctx.session.bankData.bankName}, Account Number: ${ctx.session.bankData.accountNumber}`);

      ctx.session.bankLinkingTimeout = setTimeout(() => {
        if (ctx.session.isBankLinking) {
          ctx.replyWithMarkdown('⏰ Bank linking process timed out due to inactivity. Please start again if you wish to link a bank account.');
          ctx.scene.leave();
        }
      }, 300000); // 5 minutes timeout
    } catch (error) {
      logger.error(`Error verifying bank account for user ${userId}: ${error.message}`);
      await ctx.replyWithMarkdown('❌ Failed to verify your bank account. Please ensure your details are correct or try again later.');
      
      await logUserAction(ctx.from, 'Bank Verification Failed', error.message);
      
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
      await ctx.replyWithMarkdown('⚠️ No wallet selected for linking. Please generate a wallet first using the "💼 Generate Wallet" option.');

      await logUserAction(ctx.from, 'Bank Linking Confirmation', 'No wallet selected.');

      ctx.scene.leave();
      return;
    }

    userState.wallets[walletIndex].bank = {
      bankName: bankData.bankName,
      bankCode: bankData.bankCode,
      accountNumber: bankData.accountNumber,
      accountName: bankData.accountName,
    };

    await updateUserState(userId, {
      wallets: userState.wallets,
    });

    let confirmationMessage = `✅ *Bank Account Linked Successfully!*\n\n`;
    confirmationMessage += `*Bank Name:* ${bankData.bankName}\n`;
    confirmationMessage += `*Account Number:* ${bankData.accountNumber}\n`;
    confirmationMessage += `*Account Holder:* ${bankData.accountName}\n\n`;
    confirmationMessage += `📂 *Linked Wallet Details:*\n`;
    confirmationMessage += `• *Chain:* ${userState.wallets[walletIndex].chain}\n`;
    confirmationMessage += `• *Address:* \`${userState.wallets[walletIndex].address}\`\n\n`;
    confirmationMessage += `You can now receive payouts to this bank account.`;

    await ctx.replyWithMarkdown(confirmationMessage, getMainMenu(true, userState.wallets.some(w => w.bank)));

    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🔗 User ${userId} linked a bank account:\n\n` +
      `*Account Name:* ${userState.wallets[walletIndex].bank.accountName}\n` +
      `*Bank Name:* ${userState.wallets[walletIndex].bank.bankName}\n` +
      `*Account Number:* ****${userState.wallets[walletIndex].bank.accountNumber.slice(-4)}`, { parse_mode: 'Markdown' });
    logger.info(`User ${userId} linked a bank account: ${JSON.stringify(userState.wallets[walletIndex].bank)}`);

    await logUserAction(ctx.from, 'Link Bank Account Success', `Bank: ${bankData.bankName}, Account Number: ${bankData.accountNumber}`);

    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in confirm_bank_yes handler for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('❌ An error occurred while confirming your bank details. Please try again later.');

    await logUserAction(ctx.from, 'Link Bank Account Error', error.message);

    ctx.scene.leave();
  }
});

bankLinkingScene.action('confirm_bank_no', async (ctx) => {
  await ctx.replyWithMarkdown('⚠️ Let\'s try again.');

  ctx.session.bankData = {};
  ctx.session.bankData.step = 1;

  if (ctx.session.bankLinkingTimeout) {
    clearTimeout(ctx.session.bankLinkingTimeout);
  }
  ctx.session.bankLinkingTimeout = setTimeout(() => {
    if (ctx.session.isBankLinking) {
      ctx.replyWithMarkdown('⏰ Bank linking process timed out due to inactivity. Please start again if you wish to link a bank account.');
      ctx.scene.leave();
    }
  }, 300000); // 5 minutes timeout

  await logUserAction(ctx.from, 'Decline Bank Linking', 'User declined to confirm bank details.');

  ctx.scene.reenter();
});

bankLinkingScene.action('cancel_bank_linking', async (ctx) => {
  await ctx.replyWithMarkdown('❌ Bank linking process has been canceled.');

  delete ctx.session.walletIndex;
  delete ctx.session.bankData;
  delete ctx.session.processType;
  delete ctx.session.isBankLinking;

  if (ctx.session.bankLinkingTimeout) {
    clearTimeout(ctx.session.bankLinkingTimeout);
    delete ctx.session.bankLinkingTimeout;
  }

  await logUserAction(ctx.from, 'Cancel Bank Linking', 'User canceled the bank linking process.');

  ctx.scene.leave();
});

// ===== Send Message Scene =====
sendMessageScene.enter(async (ctx) => {
  await ctx.replyWithMarkdown('📩 Please enter the User ID you want to message:');
  
  await logUserAction(ctx.from, 'Initiate Send Message', 'Prompted to enter User ID for messaging.');
});

sendMessageScene.on('message', async (ctx) => {
  const userId = ctx.from.id.toString();
  let userState;
  try {
    userState = await getUserState(userId);
  } catch (error) {
    logger.error(`Error fetching user state for ${userId}: ${error.message}`);
    await ctx.reply('⚠️ An error occurred. Please try again later.');
    return;
  }

  if (!ctx.session.sendMessageStep) {
    const userIdToMessage = ctx.message.text.trim();

    if (!/^\d{5,15}$/.test(userIdToMessage)) {
      return ctx.replyWithMarkdown('❌ Invalid User ID. Please enter a valid numeric User ID (5-15 digits):');
    }

    const userDoc = await db.collection('users').doc(userIdToMessage).get();
    if (!userDoc.exists) {
      return ctx.replyWithMarkdown('❌ User ID not found. Please ensure the User ID is correct or try another one:');
    }

    ctx.session.sendMessageStep = 2;
    ctx.session.userIdToMessage = userIdToMessage;
    await ctx.replyWithMarkdown('📝 Please enter the message you want to send to the user. You can also attach an image (receipt) with your message.');
    
    await logUserAction(ctx.from, 'Initiate Send Message', `Target User ID: ${userIdToMessage}`);
  } else if (ctx.session.sendMessageStep === 2) {
    const userIdToMessage = ctx.session.userIdToMessage;

    if (ctx.message.photo) {
      const photoArray = ctx.message.photo;
      const highestResolutionPhoto = photoArray[photoArray.length - 1];
      const fileId = highestResolutionPhoto.file_id;
      const caption = ctx.message.caption || '';

      try {
        await bot.telegram.sendPhoto(userIdToMessage, fileId, { caption: caption, parse_mode: 'Markdown' });
        await ctx.replyWithMarkdown('✅ Photo message sent successfully.');
        logger.info(`Admin ${userId} sent photo message to user ${userIdToMessage}. Caption: ${caption}`);

        await logUserAction(ctx.from, 'Send Photo Message', `Target User ID: ${userIdToMessage}, Caption: ${caption}`);
      } catch (error) {
        logger.error(`Error sending photo to user ${userIdToMessage}: ${error.message}`);
        await ctx.replyWithMarkdown('⚠️ Error sending photo. Please ensure the User ID is correct and the user has not blocked the bot.');

        await logUserAction(ctx.from, 'Send Photo Message Error', `Target User ID: ${userIdToMessage}, Error: ${error.message}`);
      }
    } else if (ctx.message.text) {
      const messageContent = ctx.message.text.trim();

      if (!messageContent) {
        return ctx.reply('❌ Message content cannot be empty. Please enter a valid message:');
      }

      try {
        await bot.telegram.sendMessage(userIdToMessage, `**📩 Message from Admin:**\n\n${messageContent}`, { parse_mode: 'Markdown' });
        await ctx.replyWithMarkdown('✅ Text message sent successfully.');
        logger.info(`Admin ${userId} sent text message to user ${userIdToMessage}: ${messageContent}`);

        await logUserAction(ctx.from, 'Send Text Message', `Target User ID: ${userIdToMessage}, Message: ${messageContent}`);
      } catch (error) {
        logger.error(`Error sending message to user ${userIdToMessage}: ${error.message}`);
        await ctx.replyWithMarkdown('⚠️ Error sending message. Please ensure the User ID is correct and the user has not blocked the bot.');

        await logUserAction(ctx.from, 'Send Text Message Error', `Target User ID: ${userIdToMessage}, Error: ${error.message}`);
      }
    } else {
      await ctx.reply('❌ Unsupported message type. Please send text or a photo (receipt).');
      return;
    }

    delete ctx.session.userIdToMessage;
    delete ctx.session.sendMessageStep;
    ctx.scene.leave();
  }
});

sendMessageScene.on('message', async (ctx) => {
  if (ctx.session.sendMessageStep !== undefined) {
    await ctx.reply('❌ Please send text messages or photos only.');
    
    await logUserAction(ctx.from, 'Unsupported Message Type', `Message Type: ${ctx.message.type}`);
  }
});

sendMessageScene.leave((ctx) => {
  delete ctx.session.userIdToMessage;
  delete ctx.session.sendMessageStep;
});

// =================== Admin Functions ===================

bot.action('open_admin_panel', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    await ctx.reply('⚠️ Unauthorized access.');

    await logUserAction(ctx.from, 'Unauthorized Access Attempt', 'Tried to open admin panel.');
    return;
  }

  ctx.session.adminMessageId = null;

  try {
    const sentMessage = await ctx.reply('👨‍💼 **Admin Panel**\n\nSelect an option below:', getAdminMenu());
    ctx.session.adminMessageId = sentMessage.message_id;

    await logUserAction(ctx.from, 'Access Admin Panel', 'Opened admin panel.');

    setTimeout(() => {
      if (ctx.session.adminMessageId) {
        ctx.deleteMessage(ctx.session.adminMessageId).catch(() => {});
        ctx.session.adminMessageId = null;
      }
    }, 300000); // Delete after 5 minutes
  } catch (error) {
    logger.error(`Error opening admin panel for user ${userId}: ${error.message}`);
    await ctx.reply('⚠️ An error occurred while opening the admin panel.');
  }

  ctx.answerCbQuery();
});

bot.action(/admin_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();

  if (!isAdmin(userId)) {
    await ctx.reply('⚠️ Unauthorized access.');

    await logUserAction(ctx.from, 'Unauthorized Admin Action', `Attempted action: admin_${ctx.match[1]}`);
    return;
  }

  const action = ctx.match[1];

  switch (action) {
    case 'view_transactions':
      try {
        const transactionsSnapshot = await db.collection('transactions').orderBy('timestamp', 'desc').limit(10).get();

        if (transactionsSnapshot.empty) {
          await ctx.answerCbQuery('No transactions found.', { show_alert: true });

          await logUserAction(ctx.from, 'View Transactions', 'No transactions available to view.');
          return;
        }

        let message = '📋 **Recent Transactions**:\n\n';

        transactionsSnapshot.forEach((doc) => {
          const tx = doc.data();
          message += `*User ID:* ${tx.userId || 'N/A'}\n`;
          message += `*Reference ID:* \`${tx.referenceId || 'N/A'}\`\n`;
          message += `*Paycrest Order ID:* \`${tx.paycrestOrderId || 'N/A'}\`\n`;
          message += `*Amount:* ${tx.amount || 'N/A'} ${tx.asset || 'N/A'}\n`;
          message += `*Status:* ${tx.status || 'Pending'}\n`;
          message += `*Chain:* ${tx.chain || 'N/A'}\n`;
          message += `*Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n\n`;
        });

        const inlineKeyboard = Markup.inlineKeyboard([
          [Markup.button.callback('🔙 Back to Admin Menu', 'admin_back_to_main')]
        ]);

        await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: inlineKeyboard.reply_markup });
        ctx.answerCbQuery();

        await logUserAction(ctx.from, 'View Transactions', `Fetched and viewed recent transactions.`);
      } catch (error) {
        logger.error(`Error fetching all transactions: ${error.message}`);
        await ctx.answerCbQuery('⚠️ Unable to fetch transactions.', { show_alert: true });

        await logUserAction(ctx.from, 'View Transactions Error', error.message);
      }
      break;

    case 'send_message':
      if (ctx.session.adminMessageId) {
        await ctx.deleteMessage(ctx.session.adminMessageId).catch(() => {});
        ctx.session.adminMessageId = null;
      }
      await ctx.scene.enter('send_message_scene');

      await logUserAction(ctx.from, 'Admin Initiate Send Message', 'Entered send message scene.');
      ctx.answerCbQuery();
      break;

    case 'mark_paid':
      try {
        const pendingTransactions = await db.collection('transactions').where('status', '==', 'Pending').get();
        if (pendingTransactions.empty) {
          await ctx.answerCbQuery('No pending transactions found.', { show_alert: true });

          await logUserAction(ctx.from, 'Mark Transactions as Paid', 'No pending transactions to mark as paid.');
          return;
        }

        const batch = db.batch();
        pendingTransactions.forEach((transaction) => {
          const docRef = db.collection('transactions').doc(transaction.id);
          batch.update(docRef, { status: 'Paid' });
        });

        await batch.commit();

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

            await logUserAction(ctx.from, 'Mark Transaction as Paid', `User ID: ${txData.userId}, Reference ID: ${txData.referenceId}`);
          } catch (error) {
            logger.error(`Error notifying user ${txData.userId}: ${error.message}`);
            await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error notifying user ${txData.userId}: ${error.message}`);
          }
        });

        await ctx.editMessageText('✅ All pending transactions have been marked as paid.', { reply_markup: getAdminMenu() });
        ctx.answerCbQuery();

        await logUserAction(ctx.from, 'Mark Transactions as Paid', `Marked ${pendingTransactions.size} transactions as paid.`);
      } catch (error) {
        logger.error(`Error marking transactions as paid: ${error.message}`);
        await ctx.answerCbQuery('⚠️ Error marking transactions as paid. Please try again later.', { show_alert: true });

        await logUserAction(ctx.from, 'Mark Transactions as Paid Error', error.message);
      }
      break;

    case 'view_users':
      try {
        const usersSnapshot = await db.collection('users').get();

        if (usersSnapshot.empty) {
          await ctx.answerCbQuery('No users found.', { show_alert: true });

          await logUserAction(ctx.from, 'View All Users', 'No users available to view.');
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

        const inlineKeyboard = Markup.inlineKeyboard([
          [Markup.button.callback('🔙 Back to Admin Menu', 'admin_back_to_main')]
        ]);

        await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: inlineKeyboard.reply_markup });
        ctx.answerCbQuery();

        await logUserAction(ctx.from, 'View All Users', `Total Users: ${usersSnapshot.size}`);
      } catch (error) {
        logger.error(`Error fetching all users: ${error.message}`);
        await ctx.answerCbQuery('⚠️ Unable to fetch users.', { show_alert: true });

        await logUserAction(ctx.from, 'View All Users Error', error.message);
      }
      break;

    case 'broadcast_message':
      await ctx.reply('📢 Please enter the message you want to broadcast to all users. You can also attach an image (receipt) with your message:');
      await updateUserState(userId, { awaitingBroadcastMessage: true });
      if (ctx.session.adminMessageId) {
        await ctx.deleteMessage(ctx.session.adminMessageId).catch(() => {});
        ctx.session.adminMessageId = null;
      }

      await logUserAction(ctx.from, 'Initiate Broadcast Message', 'Prompted to enter broadcast message.');
      ctx.answerCbQuery();
      break;

    case 'manage_banks':
      await ctx.replyWithMarkdown('🏦 **Bank Management**\n\nComing Soon!', { parse_mode: 'Markdown', reply_markup: getAdminMenu().reply_markup });
      
      await logUserAction(ctx.from, 'Access Bank Management', 'Opened bank management section.');
      
      ctx.answerCbQuery();
      break;

    case 'admin_back_to_main':
      await greetUser(ctx);
      if (ctx.session.adminMessageId) {
        await ctx.deleteMessage(ctx.session.adminMessageId).catch(() => {});
        ctx.session.adminMessageId = null;
      }

      await logUserAction(ctx.from, 'Return to Admin Menu', 'Returned to admin main menu.');
      ctx.answerCbQuery();
      break;

    default:
      await ctx.answerCbQuery('⚠️ Unknown action. Please select an option from the menu.', { show_alert: true });
      
      await logUserAction(ctx.from, 'Unknown Admin Action', `Attempted Action: admin_${action}`);
  }
});

// Handle Broadcast Message Input
bot.on('message', async (ctx, next) => {
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
    const message = ctx.message;

    if (message.photo) {
      const photoArray = message.photo;
      const highestResolutionPhoto = photoArray[photoArray.length - 1];
      const fileId = highestResolutionPhoto.file_id;
      const caption = message.caption || '';

      try {
        let successCount = 0;
        let failureCount = 0;

        const usersSnapshot = await db.collection('users').get();
        if (usersSnapshot.empty) {
          await ctx.reply('No users to broadcast to.', getAdminMenu());
          await updateUserState(userId, { awaitingBroadcastMessage: false });
          
          await logUserAction(ctx.from, 'Broadcast Photo Message', 'No users available to broadcast.');
          return;
        }

        const limiter = new Bottleneck({
          minTime: 200,
          maxConcurrent: 5,
        });

        const limitedSendPhoto = limiter.wrap(bot.telegram.sendPhoto.bind(bot.telegram));

        for (const doc of usersSnapshot.docs) {
          const targetUserId = doc.id;
          try {
            await limitedSendPhoto(targetUserId, fileId, { caption: caption, parse_mode: 'Markdown' });
            successCount++;
          } catch (error) {
            logger.error(`Error sending broadcast photo to user ${targetUserId}: ${error.message}`);
            failureCount++;
          }
        }

        await ctx.reply(`✅ Broadcast completed.\n\n📬 Successful: ${successCount}\n❌ Failed: ${failureCount}`, getAdminMenu());
        logger.info(`Admin ${userId} broadcasted photo message. Success: ${successCount}, Failed: ${failureCount}`);

        await logUserAction(ctx.from, 'Broadcast Photo Message', `Success: ${successCount}, Failed: ${failureCount}`);
      } catch (error) {
        logger.error(`Broadcast Photo Error: ${error.message}`);
        await ctx.replyWithMarkdown('⚠️ An error occurred while broadcasting the photo. Please try again later.', getAdminMenu());

        await logUserAction(ctx.from, 'Broadcast Photo Message Error', error.message);
      }
    } else if (message.text) {
      const broadcastMessage = message.text.trim();
      if (!broadcastMessage) {
        return ctx.reply('❌ Message content cannot be empty. Please enter a valid message:');
      }

      try {
        let successCount = 0;
        let failureCount = 0;

        const usersSnapshot = await db.collection('users').get();
        if (usersSnapshot.empty) {
          await ctx.reply('No users to broadcast to.', getAdminMenu());
          await updateUserState(userId, { awaitingBroadcastMessage: false });
          
          await logUserAction(ctx.from, 'Broadcast Text Message', 'No users available to broadcast.');
          return;
        }

        const limiter = new Bottleneck({
          minTime: 200,
          maxConcurrent: 5,
        });

        const limitedSendMessage = limiter.wrap(bot.telegram.sendMessage.bind(bot.telegram));

        for (const doc of usersSnapshot.docs) {
          const targetUserId = doc.id;
          try {
            await limitedSendMessage(targetUserId, `📢 *Broadcast Message:*\n\n${broadcastMessage}`, { parse_mode: 'Markdown' });
            successCount++;
          } catch (error) {
            logger.error(`Error sending broadcast message to user ${targetUserId}: ${error.message}`);
            failureCount++;
          }
        }

        await ctx.reply(`✅ Broadcast completed.\n\n📬 Successful: ${successCount}\n❌ Failed: ${failureCount}`, getAdminMenu());
        logger.info(`Admin ${userId} broadcasted message. Success: ${successCount}, Failed: ${failureCount}`);

        await logUserAction(ctx.from, 'Broadcast Text Message', `Success: ${successCount}, Failed: ${failureCount}`);
      } catch (error) {
        logger.error(`Broadcast Text Error: ${error.message}`);
        await ctx.replyWithMarkdown('⚠️ An error occurred while broadcasting the message. Please try again later.', getAdminMenu());

        await logUserAction(ctx.from, 'Broadcast Text Message Error', error.message);
      }
    } else {
      await ctx.reply('❌ Unsupported message type. Please send text or a photo (receipt).', getAdminMenu());

      await logUserAction(ctx.from, 'Broadcast Unsupported Message Type', `Message Type: ${message.type}`);
    }

    await updateUserState(userId, { awaitingBroadcastMessage: false });
  }

  await next();
});

// =================== Handle "💰 Transactions" Button ===================
bot.hears('💰 Transactions', async (ctx) => {
  await ctx.replyWithMarkdown('💰 *Transactions Section*\n\nComing Soon!', { parse_mode: 'Markdown' });
  
  await logUserAction(ctx.from, 'Access Transactions', 'Opened transactions section.');
});

// =================== Handle "ℹ️ Support" Button ===================
bot.hears('ℹ️ Support', async (ctx) => {
  await ctx.replyWithMarkdown('ℹ️ *Support Section*\n\nIf you need assistance, please contact our support team at [@your_support_username](https://t.me/your_support_username).', { parse_mode: 'Markdown' });
  
  await logUserAction(ctx.from, 'Access Support', 'Opened support section.');
});

// =================== Handle "📘 Learn About Base" Button ===================
bot.hears('📘 Learn About Base', async (ctx) => {
  await ctx.replyWithMarkdown('📘 *Learn About Base*\n\nBase is a secure and scalable smart contract platform designed to power decentralized applications. [Learn more here](https://base.org).');
  
  await logUserAction(ctx.from, 'Learn About Base', 'Accessed Base information.');
});

// =================== Handle "🏦 Link Bank Account" Button ===================
bot.hears('🏦 Link Bank Account', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    
    if (userState.wallets.length === 0) {
      await ctx.replyWithMarkdown('❌ You have no wallets. Please generate a wallet first using the "💼 Generate Wallet" option.');

      await logUserAction(ctx.from, 'Attempted Bank Linking', 'No wallets available.');
      return;
    }

    if (userState.wallets.length === 1) {
      ctx.session.walletIndex = 0;
      await ctx.scene.enter('bank_linking_scene');

      await logUserAction(ctx.from, 'Initiate Bank Linking', `Selected Wallet 1 on ${userState.wallets[0].chain}.`);
    } else {
      let keyboard = userState.wallets.map((wallet, index) => [
        Markup.button.callback(`Wallet ${index + 1} - ${wallet.chain}`, `select_wallet_${index}`)
      ]);
      keyboard.push([Markup.button.callback('🔙 Back to Settings Menu', 'settings_back_to_main')]);
      await ctx.reply('Please select the wallet you want to link a bank account to:', Markup.inlineKeyboard(keyboard));

      await logUserAction(ctx.from, 'Prompt Wallet Selection for Bank Linking', `Total Wallets: ${userState.wallets.length}`);
    }
  } catch (error) {
    logger.error(`Error handling Link Bank Account for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while initiating bank linking. Please try again later.');

    await logUserAction(ctx.from, 'Link Bank Account Error', error.message);
  }
});

// Handle Wallet Selection for Linking Bank Account
bot.action(/select_wallet_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);
  
  try {
    const userState = await getUserState(userId);

    if (isNaN(walletIndex) || walletIndex < 0 || walletIndex >= userState.wallets.length) {
      await ctx.replyWithMarkdown('⚠️ Invalid wallet selection. Please try again.');

      await logUserAction(ctx.from, 'Bank Linking Wallet Selection', `Selected Wallet Index: ${walletIndex}`);
      
      return ctx.answerCbQuery();
    }

    ctx.session.walletIndex = walletIndex;
    await ctx.scene.enter('bank_linking_scene');

    await logUserAction(ctx.from, 'Select Wallet for Bank Linking', `Selected Wallet ${walletIndex + 1} on ${userState.wallets[walletIndex].chain}.`);
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error handling wallet selection for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');

    await logUserAction(ctx.from, 'Wallet Selection Error', error.message);
    
    await ctx.answerCbQuery();
  }
});

// =================== Handle "✏️ Edit Linked Bank Details" Action ===================
bot.action('settings_edit_bank', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    
    if (userState.wallets.length === 0) {
      await ctx.replyWithMarkdown('❌ You have no wallets. Please generate a wallet first using the "💼 Generate Wallet" option.');

      await logUserAction(ctx.from, 'Edit Linked Bank Details Attempt', 'No wallets available.');
      return ctx.answerCbQuery();
    }

    if (userState.wallets.length === 1) {
      ctx.session.walletIndex = 0;
      await ctx.scene.enter('bank_linking_scene');
      
      await logUserAction(ctx.from, 'Edit Linked Bank Details', `Selected Wallet 1 on ${userState.wallets[0].chain}.`);
    } else {
      let keyboard = userState.wallets.map((wallet, index) => [
        Markup.button.callback(`Wallet ${index + 1} - ${wallet.chain}`, `edit_bank_wallet_${index}`)
      ]);
      keyboard.push([Markup.button.callback('🔙 Back to Settings Menu', 'settings_back_to_main')]);
      
      await ctx.reply('Please select the wallet for which you want to edit the bank details:', Markup.inlineKeyboard(keyboard));
      
      await logUserAction(ctx.from, 'Prompt Wallet Selection for Bank Editing', `Total Wallets: ${userState.wallets.length}`);
    }
  } catch (error) {
    logger.error(`Error initiating bank editing for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ Unable to edit bank details. Please try again later.');
    
    await logUserAction(ctx.from, 'Edit Linked Bank Details Error', error.message);
    ctx.answerCbQuery();
  }
});

// Handle Wallet Selection for Editing Bank Details
bot.action(/edit_bank_wallet_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);
  
  try {
    const userState = await getUserState(userId);
    
    if (isNaN(walletIndex) || walletIndex < 0 || walletIndex >= userState.wallets.length) {
      await ctx.replyWithMarkdown('⚠️ Invalid wallet selection.');

      await logUserAction(ctx.from, 'Edit Bank Details', `Invalid wallet index: ${walletIndex}`);
      return ctx.answerCbQuery();
    }
    
    const wallet = userState.wallets[walletIndex];
    
    ctx.session.walletIndex = walletIndex;
    
    await ctx.scene.enter('bank_linking_scene');
    
    await logUserAction(ctx.from, 'Edit Linked Bank Details', `Editing Bank for Wallet ${walletIndex + 1} on ${wallet.chain}.`);
    
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error editing bank details for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ Unable to edit bank details. Please try again later.');
    
    await logUserAction(ctx.from, 'Edit Linked Bank Details Error', error.message);
    ctx.answerCbQuery();
  }
});

// =================== Handle "🧾 Generate Transaction Receipt" Action ===================
bot.action('settings_generate_receipt', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const transactionsSnapshot = await db.collection('transactions').where('userId', '==', userId).orderBy('timestamp', 'desc').limit(5).get();
    
    if (transactionsSnapshot.empty) {
      await ctx.replyWithMarkdown('📄 You have no transactions to generate receipts for.');
      
      await logUserAction(ctx.from, 'Generate Transaction Receipt', 'No transactions available.');
      return ctx.answerCbQuery();
    }
    
    let receiptMessage = '🧾 *Recent Transaction Receipts*:\n\n';
    
    transactionsSnapshot.forEach((doc) => {
      const tx = doc.data();
      receiptMessage += `*Reference ID:* \`${tx.referenceId || 'N/A'}\`\n`;
      receiptMessage += `*Paycrest Order ID:* \`${tx.paycrestOrderId || 'N/A'}\`\n`;
      receiptMessage += `*Amount:* ${tx.amount || 'N/A'} ${tx.asset || 'N/A'}\n`;
      receiptMessage += `*Status:* ${tx.status || 'Pending'}\n`;
      receiptMessage += `*Chain:* ${tx.chain || 'N/A'}\n`;
      receiptMessage += `*Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n\n`;
    });
    
    await ctx.replyWithMarkdown(receiptMessage, Markup.inlineKeyboard([
      [Markup.button.callback('🔙 Back to Settings Menu', 'settings_back_to_main')]
    ]));

    await logUserAction(ctx.from, 'Generate Transaction Receipt', `Generated receipts for ${transactionsSnapshot.size} transactions.`);
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error generating transaction receipts for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ Unable to generate receipts. Please try again later.');
    
    await logUserAction(ctx.from, 'Generate Transaction Receipt Error', error.message);
    ctx.answerCbQuery();
  }
});

// =================== Handle "📈 View Current Rates" Button ===================
bot.hears('📈 View Current Rates', async (ctx) => {
  try {
    let message = '📈 *Current Exchange Rates*:\n\n';
    for (const [asset, rate] of Object.entries(exchangeRates)) {
      message += `• *${asset}*: ₦${rate}\n`;
    }
    message += `\n*Latest Rates:* Updated just now.`;
    await ctx.replyWithMarkdown(message, Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Refresh Rates', 'refresh_rates')]
    ]));

    await logUserAction(ctx.from, 'View Exchange Rates', 'Viewed current exchange rates.');
  } catch (error) {
    logger.error(`Error fetching exchange rates for user ${ctx.from.id}: ${error.message}`);
    await ctx.reply('⚠️ Unable to fetch exchange rates at the moment. Please try again later.');

    await logUserAction(ctx.from, 'View Exchange Rates Error', error.message);
  }
});

// =================== Handle "🔄 Refresh Rates" Action ===================
bot.action('refresh_rates', async (ctx) => {
  try {
    await fetchExchangeRates();
    let message = '🔄 *Exchange Rates Refreshed*:\n\n';
    for (const [asset, rate] of Object.entries(exchangeRates)) {
      message += `• *${asset}*: ₦${rate}\n`;
    }
    message += `\n*Latest Rates:* Updated just now.`;
    await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Refresh Rates', 'refresh_rates')]
    ]).reply_markup });
    ctx.answerCbQuery();

    await logUserAction(ctx.from, 'Refresh Exchange Rates', 'Manually refreshed exchange rates.');
  } catch (error) {
    logger.error(`Error refreshing exchange rates: ${error.message}`);
    await ctx.reply('⚠️ Unable to refresh exchange rates at the moment. Please try again later.');

    await logUserAction(ctx.from, 'Refresh Exchange Rates Error', error.message);
    ctx.answerCbQuery();
  }
});

// =================== Handle "💼 Generate Wallet" Button ===================
bot.hears('💼 Generate Wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    
    if (userState.wallets.length >= MAX_WALLETS) {
      await ctx.replyWithMarkdown(`⚠️ You have reached the maximum number of wallets (${MAX_WALLETS}). Please manage your existing wallets before adding new ones.`);
      
      await logUserAction(ctx.from, 'Attempted Wallet Generation', `Reached wallet limit (${MAX_WALLETS}).`);
      
      return;
    }
    
    await ctx.reply('📂 *Select the network for which you want to generate a wallet:*', Markup.inlineKeyboard([
      [Markup.button.callback('Base', 'generate_wallet_Base')],
      [Markup.button.callback('Polygon', 'generate_wallet_Polygon')],
      [Markup.button.callback('BNB Smart Chain', 'generate_wallet_BNB Smart Chain')],
    ]));

    await logUserAction(ctx.from, 'Initiate Wallet Generation', `Selected Networks: Base, Polygon, BNB Smart Chain.`);
  } catch (error) {
    logger.error(`Error handling Generate Wallet for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while generating your wallet. Please try again later.');

    await logUserAction(ctx.from, 'Generate Wallet Error', error.message);
  }
});

// Handle Wallet Generation for Inline Buttons
bot.action(/generate_wallet_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const selectedChainRaw = ctx.match[1];

  const selectedChainKey = chainMapping[selectedChainRaw.toLowerCase()];
  if (!selectedChainKey) {
    await ctx.replyWithMarkdown('⚠️ Invalid network selection. Please try again.');
    
    await logUserAction(ctx.from, 'Generate Wallet Invalid Network', `Selected Chain: ${selectedChainRaw}`);
    
    return ctx.answerCbQuery();
  }

  const chain = selectedChainKey;

  await ctx.answerCbQuery();

  const generatingMessage = await ctx.replyWithMarkdown(`🔄 Generating Wallet for *${chain}*... Please wait a moment.`);

  try {
    const walletAddress = await generateWallet(chain);

    const userState = await getUserState(userId);

    if (userState.wallets.length >= MAX_WALLETS) {
      await ctx.replyWithMarkdown(`⚠️ You cannot generate more than ${MAX_WALLETS} wallets.`);
      
      await logUserAction(ctx.from, 'Generate Wallet Attempt', `Reached wallet limit (${MAX_WALLETS}).`);
      
      await ctx.deleteMessage(generatingMessage.message_id);
      return;
    }

    userState.wallets.push({
      address: walletAddress || 'N/A',
      chain: chain || 'N/A',
      supportedAssets: chains[chain].supportedAssets ? [...chains[chain].supportedAssets] : [],
      bank: null,
      amount: 0
    });

    const updatedWalletAddresses = userState.walletAddresses || [];
    updatedWalletAddresses.push(walletAddress);

    await updateUserState(userId, {
      wallets: userState.wallets,
      walletAddresses: updatedWalletAddresses,
    });

    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `💼 Wallet generated for user ${userId} on ${chain}: ${walletAddress}`, { parse_mode: 'Markdown' });
    logger.info(`Wallet generated for user ${userId} on ${chain}: ${walletAddress}`);

    await logUserAction(ctx.from, 'Generate Wallet Success', `Chain: ${chain}, Wallet Address: ${walletAddress}`);

    delete ctx.session.walletIndex;

    await ctx.deleteMessage(generatingMessage.message_id);

    await ctx.replyWithMarkdown('✅ Wallet generated successfully! You can now link a bank account using the "⚙️ Settings" menu.', getMainMenu(true, userState.wallets.some(w => w.bank)));
  } catch (error) {
    logger.error(`Error generating wallet for user ${userId} on ${chain}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ There was an issue generating your wallet. Please try again later.');

    await logUserAction(ctx.from, 'Generate Wallet Error', error.message);
  }
});

// =================== Handle "💼 View Wallet" Button ===================
bot.hears('💼 View Wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    
    if (userState.wallets.length === 0) {
      await ctx.replyWithMarkdown('❌ You have no wallets. Please generate a wallet first using the "💼 Generate Wallet" option.');

      await logUserAction(ctx.from, 'View Wallets', 'Attempted to view wallets without any existing.');
      return;
    }
    
    let message = '💼 *Your Wallets*:\n\n';
    userState.wallets.forEach((wallet, index) => {
      message += `*Wallet ${index + 1}:*\n`;
      message += `• *Chain:* ${wallet.chain}\n`;
      message += `• *Address:* \`${wallet.address}\`\n`;
      message += `• *Bank Linked:* ${wallet.bank ? '✅ Yes' : '❌ No'}\n\n`;
    });
    
    const inlineKeyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🔍 View Wallet Details', 'view_wallet_details')],
      [Markup.button.callback('⚙️ Manage Wallet', 'manage_wallet')],
      [Markup.button.callback('🔙 Back to Main Menu', 'back_to_main')]
    ]);
    
    await ctx.replyWithMarkdown(message, inlineKeyboard);
    
    await logUserAction(ctx.from, 'View Wallets', `Total Wallets: ${userState.wallets.length}`);
  } catch (error) {
    logger.error(`Error handling View Wallet for user ${userId}: ${error.message}`);
    await ctx.reply('⚠️ An error occurred while fetching your wallets. Please try again later.');

    await logUserAction(ctx.from, 'View Wallets Error', error.message);
  }
});

// =================== Handle "🔍 View Wallet Details" Action ===================
bot.action('view_wallet_details', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    
    if (userState.wallets.length === 0) {
      await ctx.replyWithMarkdown('❌ You have no wallets to view details.');
      
      await logUserAction(ctx.from, 'View Wallet Details', 'No wallets available.');
      return ctx.answerCbQuery();
    }
    
    let detailsMessage = '📄 *Wallet Details*:\n\n';
    userState.wallets.forEach((wallet, index) => {
      detailsMessage += `*Wallet ${index + 1}:*\n`;
      detailsMessage += `• *Chain:* ${wallet.chain}\n`;
      detailsMessage += `• *Address:* \`${wallet.address}\`\n`;
      detailsMessage += `• *Supported Assets:* ${wallet.supportedAssets.join(', ')}\n`;
      detailsMessage += `• *Bank Linked:* ${wallet.bank ? '✅ Yes' : '❌ No'}\n\n`;
    });
    
    const inlineKeyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🔙 Back to Wallet Menu', 'back_to_wallet_menu')]
    ]);
    
    await ctx.replyWithMarkdown(detailsMessage, inlineKeyboard);
    ctx.answerCbQuery();
    
    await logUserAction(ctx.from, 'View Wallet Details', 'Displayed detailed wallet information.');
  } catch (error) {
    logger.error(`Error viewing wallet details for user ${userId}: ${error.message}`);
    await ctx.answerCbQuery('⚠️ Unable to fetch wallet details.', { show_alert: true });
    
    await logUserAction(ctx.from, 'View Wallet Details Error', error.message);
  }
});

// =================== Handle "🔙 Back to Main Menu" Action ===================
bot.action('back_to_main', async (ctx) => {
  await ctx.deleteMessage().catch(() => {});
  await greetUser(ctx);

  await logUserAction(ctx.from, 'Back to Main Menu', 'Returned to main menu from wallet actions.');
  ctx.answerCbQuery();
});

// =================== Handle "🔙 Back to Wallet Menu" Action ===================
bot.action('back_to_wallet_menu', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    
    if (userState.wallets.length === 0) {
      await ctx.replyWithMarkdown('❌ You have no wallets to view.');
      
      await logUserAction(ctx.from, 'Back to Wallet Menu', 'No wallets available.');
      return ctx.answerCbQuery();
    }
    
    let message = '💼 *Your Wallets*:\n\n';
    userState.wallets.forEach((wallet, index) => {
      message += `*Wallet ${index + 1}:*\n`;
      message += `• *Chain:* ${wallet.chain}\n`;
      message += `• *Address:* \`${wallet.address}\`\n`;
      message += `• *Bank Linked:* ${wallet.bank ? '✅ Yes' : '❌ No'}\n\n`;
    });
    
    const inlineKeyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🔍 View Wallet Details', 'view_wallet_details')],
      [Markup.button.callback('⚙️ Manage Wallet', 'manage_wallet')],
      [Markup.button.callback('🔙 Back to Main Menu', 'back_to_main')]
    ]);
    
    await ctx.replyWithMarkdown(message, inlineKeyboard);
    ctx.answerCbQuery();
    
    await logUserAction(ctx.from, 'Back to Wallet Menu', `Returned to wallet overview.`);
  } catch (error) {
    logger.error(`Error returning to wallet menu for user ${userId}: ${error.message}`);
    await ctx.answerCbQuery('⚠️ Unable to return to wallet menu.', { show_alert: true });
    
    await logUserAction(ctx.from, 'Back to Wallet Menu Error', error.message);
  }
});

// =================== Admin Functions Continued ===================

// =================== Handle "📋 View All Transactions" Action ===================
// Already handled in the 'admin_view_transactions' case above

// =================== Handle "📩 Send Message to User" Action ===================
// Already handled in the 'admin_send_message' case above

// =================== Handle "✅ Mark Transactions as Paid" Action ===================
// Already handled in the 'admin_mark_paid' case above

// =================== Handle "👥 View All Users" Action ===================
// Already handled in the 'admin_view_users' case above

// =================== Handle "📢 Broadcast Message" Action ===================
// Already handled in the 'admin_broadcast_message' case above

// =================== Handle "🏦 Manage Banks" Action ===================
// Already handled in the 'admin_manage_banks' case above

// =================== Handle Webhook for Paycrest ===================

function verifyPaycrestSignature(rawBody, signature, clientSecret) {
  const hmac = crypto.createHmac('sha256', clientSecret);
  hmac.update(rawBody, 'utf8');
  const digest = hmac.digest('hex');
  return digest === signature;
}

app.post('/webhook/paycrest', async (req, res) => {
  try {
    const event = req.body;
    logger.info(`Received Paycrest webhook: ${JSON.stringify(event)}`);
    fs.appendFileSync(path.join(__dirname, 'webhook_logs.txt'), `${new Date().toISOString()} - ${JSON.stringify(event, null, 2)}\n`);

    const eventType = event.event || 'Unknown Event';
    const orderId = event.data?.id || 'N/A';
    const amount = parseFloat(event.data?.amount) || 0;
    const token = event.data?.token || 'N/A';
    const network = event.data?.network || 'N/A';
    const receiveAddress = event.data?.receiveAddress || 'N/A';

    if (eventType === 'payment_order.settled') {
      try {
        const txSnapshot = await db.collection('transactions').where('paycrestOrderId', '==', orderId).limit(1).get();
        if (txSnapshot.empty) {
          logger.error(`No transaction found for Paycrest orderId: ${orderId}`);
          return res.status(200).send('OK');
        }

        const txDoc = txSnapshot.docs[0];
        const txData = txDoc.data();
        const userId = txData.userId;
        const messageId = txData.messageId;

        await db.collection('transactions').doc(txDoc.id).update({ status: 'Paid' });

        await bot.telegram.sendMessage(userId, `🎉 *Transaction Successful!*\n\n` +
          `*Reference ID:* \`${txData.referenceId || 'N/A'}\`\n` +
          `*Amount Paid:* ${txData.amount} ${txData.asset}\n` +
          `*Bank:* ${txData.bankDetails.bankName || 'N/A'}\n` +
          `*Account Number:* ****${txData.bankDetails.accountNumber.slice(-4)}\n` +
          `*Date:* ${new Date(txData.timestamp).toLocaleString()}\n\n` +
          `Thank you for using *DirectPay*! Your funds have been securely transferred to your bank account. If you have any questions or need further assistance, feel free to [contact our support team](https://t.me/maxcswap).`,
          { parse_mode: 'Markdown' }
        );

        if (messageId) {
          try {
            await bot.telegram.editMessageText(userId, messageId, null, `🎉 *Transaction Successful!*\n\n` +
              `Your DirectPay order has been completed. Here are the details of your transaction:\n\n` +
              `*Reference ID:* ${txData.referenceId}\n` +
              `*Amount Paid:* ${txData.amount} ${txData.asset}\n` +
              `*Bank:* ${txData.bankDetails.bankName}\n` +
              `*Account Number:* ****${txData.bankDetails.accountNumber.slice(-4)}\n` +
              `*Date:* ${new Date(txData.timestamp).toLocaleString()}\n\n` +
              `Thank you for using *DirectPay*! Your funds have been securely transferred to your bank account.`,
              { parse_mode: 'Markdown' }
            );

            await logUserAction({ id: userId }, 'Funds Credited', `Reference ID: ${txData.referenceId}, Paycrest Order ID: ${orderId}`);
          } catch (error) {
            logger.error(`Error editing message for user ${userId}: ${error.message}`);
            await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Failed to edit message for user ${userId}: ${error.message}`);
            
            await logUserAction(ctx.from, 'Edit Funds Credited Message Failed', `User ID: ${userId}, Error: ${error.message}`);
          }
        }

        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `✅ *Payment Completed*\n\n` +
          `*User ID:* ${userId}\n` +
          `*Reference ID:* ${txData.referenceId}\n` +
          `*Paycrest Order ID:* ${orderId}\n` +
          `*Amount:* ${txData.amount} ${txData.asset}\n` +
          `*Bank:* ${txData.bankDetails.bankName}\n` +
          `*Account Number:* ****${txData.bankDetails.accountNumber.slice(-4)}\n` +
          `*Date:* ${new Date(txData.timestamp).toLocaleString()}\n`, { parse_mode: 'Markdown' });

        await logUserAction(ctx.from, 'Payment Completed', `User ID: ${userId}, Reference ID: ${txData.referenceId}, Paycrest Order ID: ${orderId}`);
        
        res.status(200).send('OK');
      } catch (error) {
        logger.error(`Error processing Paycrest webhook for orderId ${orderId}: ${error.message}`);
        res.status(500).send('Error');
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error processing Paycrest webhook for orderId ${orderId}: ${error.message}`, { parse_mode: 'Markdown' });

        await logUserAction(ctx.from, 'Paycrest Webhook Processing Error', `Order ID: ${orderId}, Error: ${error.message}`);
      }
    } else {
      logger.info(`Unhandled Paycrest event: ${eventType}`);
      res.status(200).send('OK');

      await logUserAction(ctx.from, 'Unhandled Paycrest Event', `Event: ${eventType}`);
    }
  } catch (error) {
    logger.error(`Error processing Paycrest webhook: ${error.message}`);
    res.status(500).send('Error');
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error processing Paycrest webhook: ${error.message}`, { parse_mode: 'Markdown' });

    await logUserAction(ctx.from, 'Paycrest Webhook Processing Error', `Error: ${error.message}`);
  }
});

// =================== Handle Webhook for Blockradar ===================
app.post('/webhook/blockradar', async (req, res) => {
  try {
    const event = req.body;
    logger.info(`Received Blockradar webhook: ${JSON.stringify(event)}`);
    fs.appendFileSync(path.join(__dirname, 'webhook_logs.txt'), `${new Date().toISOString()} - ${JSON.stringify(event, null, 2)}\n`);

    const eventType = event.event || 'Unknown Event';
    const walletAddress = event.data?.recipientAddress || 'N/A';
    const amount = parseFloat(event.data?.amount) || 0;
    const asset = event.data?.asset?.symbol || 'N/A';
    const transactionHash = event.data?.hash || 'N/A';
    const chainRaw = event.data?.blockchain?.name || 'N/A';

    const chainKey = chainMapping[chainRaw.toLowerCase()];
    if (!chainKey) {
      logger.error(`Unknown chain received in webhook: ${chainRaw}`);
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ Received deposit on unknown chain: \`${chainRaw}\``);
      return res.status(400).send('Unknown chain.');
    }

    const chain = chainKey;

    if (eventType === 'deposit.success') {
      if (walletAddress === 'N/A') {
        logger.error('Webhook missing wallet address.');
        return res.status(400).send('Missing wallet address.');
      }

      // **Duplicate Check Start**
      const existingTxSnapshot = await db.collection('transactions').where('transactionHash', '==', transactionHash).get();
      if (!existingTxSnapshot.empty) {
        logger.info(`Transaction with hash ${transactionHash} already exists. Skipping.`);
        return res.status(200).send('OK');
      }
      // **Duplicate Check End**

      const usersSnapshot = await db.collection('users').where('walletAddresses', 'array-contains', walletAddress).get();
      if (usersSnapshot.empty) {
        logger.warn(`No user found for wallet ${walletAddress}`);
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ No user found for wallet address: \`${walletAddress}\``);
        return res.status(200).send('OK');
      }

      const userDoc = usersSnapshot.docs[0];
      const userId = userDoc.id;
      const userState = userDoc.data();
      const wallet = userState.wallets.find((w) => w.address === walletAddress);

      if (!wallet || !wallet.bank) {
        await bot.telegram.sendMessage(userId, `💰 *Deposit Received:* ${amount} ${asset} on ${chainRaw}.\n\nPlease link a bank account to receive your payout securely.`, { parse_mode: 'Markdown' });
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ User ${userId} has received a deposit but hasn't linked a bank account.`, { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      }

      if (!SUPPORTED_ASSETS.includes(asset)) {
        await bot.telegram.sendMessage(userId, `⚠️ *Unsupported Asset Deposited:* ${asset}.\n\nCurrently, only *USDC* and *USDT* are supported. Please contact support if you believe this is an error.`, { parse_mode: 'Markdown' });
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ User ${userId} deposited unsupported asset: ${asset}.`, { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      }

      const rate = exchangeRates[asset];
      if (!rate) {
        throw new Error(`Exchange rate for ${asset} not available.`);
      }

      const ngnAmount = calculatePayout(asset, amount);

      const referenceId = generateReferenceId();
      const bankName = wallet.bank.bankName || 'N/A';
      const bankAccount = wallet.bank.accountNumber || 'N/A';
      const accountName = wallet.bank.accountName || 'Valued User';

      const userFirstName = userState.firstName || 'Valued User';

      const transactionRef = await db.collection('transactions').add({
        userId: userId,
        walletAddress,
        chain: chainRaw,
        amount: amount,
        asset: asset,
        transactionHash: transactionHash,
        referenceId: referenceId,
        bankDetails: wallet.bank,
        payout: ngnAmount,
        timestamp: new Date().toISOString(),
        status: 'Processing',
        paycrestOrderId: '',
        messageId: null
      });

      const pendingMessage = await bot.telegram.sendMessage(userId,
        `🎉 *Deposit Received!*\n\n` +
        `*Reference ID:* \`${referenceId}\`\n` +
        `*Amount Deposited:* ${amount} ${asset}\n` +
        `*Network:* ${chainRaw}\n\n` +
        `🔄 *Your order has begun processing!* ⏳\n\n` +
        `We are converting your crypto to NGN at the current exchange rate of ₦${rate} per ${asset}. Your cash will be credited to your linked bank account shortly.\n\n` +
        `Thank you for using *DirectPay*!`,
        { parse_mode: 'Markdown' }
      );

      await transactionRef.update({
        messageId: pendingMessage.message_id
      });

      const adminDepositMessage = `⚡️ *New Deposit Received*\n\n` +
        `*User ID:* ${userId}\n` +
        `*Reference ID:* ${referenceId}\n` +
        `*Paycrest Order ID:* \`${orderId || 'N/A'}\`\n` +
        `*Amount:* ${amount} ${asset}\n` +
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

      const paycrestMapping = mapToPaycrest(asset, chainRaw);
      if (!paycrestMapping) {
        logger.error('No Paycrest mapping for this asset/chain.');
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ No Paycrest mapping found for asset ${asset} on chain ${chainRaw}.`);
        return res.status(200).send('OK');
      }

      let paycrestOrder;
      try {
        paycrestOrder = await createPaycrestOrder(userId, amount, asset, chainRaw, wallet.bank);
        await transactionRef.update({ paycrestOrderId: paycrestOrder.id });
      } catch (err) {
        logger.error(`Error creating Paycrest order for user ${userId}: ${err.message}`);
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error creating Paycrest order for user ${userId}: ${err.message}`);
        await db.collection('transactions').doc(txDoc.id).update({ status: 'Failed' });
        const failureMessage = `Hello ${userFirstName},\n\n` +
          `⚠️ *Your DirectPay order has failed to process.*\n\n` +
          `Please contact our support team for assistance.`;
        await bot.telegram.editMessageText(userId, pendingMessage.message_id, null, failureMessage, { parse_mode: 'Markdown' });
        return res.status(500).send('Paycrest order error');
      }

      const receiveAddress = paycrestOrder.receiveAddress;

      try {
        const assetId = chains[chainRaw].assets[asset];
        if (!assetId) {
          throw new Error(`No Asset ID found for ${asset} on ${chainRaw}`);
        }

        await withdrawFromBlockradar(chainRaw, assetId, receiveAddress, amount, referenceId, { userId });

        await transactionRef.update({ status: 'Completed' });

        const successMessage = `🎉 *Deposit and Withdrawal Successful!*\n\n` +
          `Your deposit of ${amount} ${asset} on ${chainRaw} has been converted and withdrawn to your bank account.\n\n` +
          `*Reference ID:* ${referenceId}\n` +
          `*Exchange Rate:* ₦${rate} per ${asset}\n` +
          `*Cash Amount:* ₦${ngnAmount}\n` +
          `*Transaction Hash:* \`${transactionHash}\`\n\n` +
          `Thank you for using *DirectPay*! If you have any questions or need further assistance, feel free to [contact our support team](https://t.me/maxcswap).`;
        await bot.telegram.editMessageText(userId, pendingMessage.message_id, null, successMessage, { parse_mode: 'Markdown' });

        await logUserAction({ id: userId }, 'Withdrawal Success', `Reference ID: ${referenceId}, Amount: ${amount} ${asset}, Withdrawn to: ${receiveAddress}`);
      } catch (error) {
        logger.error(`Error withdrawing for user ${userId}: ${error.message}`);
        await transactionRef.update({ status: 'Failed' });

        const failureMessage = `Hello ${userFirstName},\n\n` +
          `⚠️ *Your DirectPay order has encountered an issue during withdrawal.*\n\n` +
          `*Reference ID:* ${referenceId}\n` +
          `*Error:* ${error.message}\n\n` +
          `Please contact our support team for assistance.`;
        await bot.telegram.editMessageText(userId, pendingMessage.message_id, null, failureMessage, { parse_mode: 'Markdown' });

        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Withdrawal failed for user ${userId}: Reference ID ${referenceId}, Error: ${error.message}`, { parse_mode: 'Markdown' });
      }

      res.status(200).send('OK');
    } else {
      logger.info(`Unhandled Blockradar event: ${eventType}`);
      res.status(200).send('OK');

      await logUserAction(ctx.from, 'Unhandled Blockradar Event', `Event: ${eventType}`);
    }
  } catch (error) {
    logger.error(`Error processing Blockradar webhook: ${error.message}`);
    res.status(500).send('Error');
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error processing Blockradar webhook: ${error.message}`, { parse_mode: 'Markdown' });

    await logUserAction(ctx.from, 'Blockradar Webhook Processing Error', `Error: ${error.message}`);
  }
});

// =================== Withdraw from Blockradar Function ===================
async function withdrawFromBlockradar(chain, assetId, address, amount, reference, metadata) {
  try {
    const normalizedChain = chain.trim();

    const apiKey = BLOCKRADAR_API_KEYS[normalizedChain];

    if (!apiKey) {
      throw new Error(`No Blockradar API Key configured for network: ${normalizedChain}`);
    }

    const chainData = chains[normalizedChain];
    if (!chainData) {
      throw new Error(`Unsupported or unknown chain: ${normalizedChain}`);
    }

    const withdrawalPayload = {
      address: address,
      amount: String(amount),
      assetId: assetId,
      reference: reference,
      metadata: metadata
    };

    const response = await axios.post(
      `https://api.blockradar.co/v1/wallets/${chainData.id}/withdraw`,
      withdrawalPayload,
      {
        headers: {
          'x-api-key': apiKey,
          'Content-Type': 'application/json'
        }
      }
    );

    const data = response.data;

    if (data.statusCode !== 200) {
      throw new Error(`Blockradar withdrawal error: ${JSON.stringify(data)}`);
    }

    logger.info(`Withdrawal successful for user ${metadata.userId}: Reference ID ${reference}, Amount ${amount} on ${normalizedChain}`);

    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `✅ *Withdrawal Initiated*\n\n` +
      `*User ID:* ${metadata.userId}\n` +
      `*Reference ID:* ${reference}\n` +
      `*Amount:* ${amount} ${chainData.supportedAssets.join(', ')}\n` +
      `*Chain:* ${normalizedChain}\n` +
      `*Timestamp:* ${new Date().toLocaleString()}\n`, { parse_mode: 'Markdown' });

    return data;
  } catch (error) {
    logger.error(`Error withdrawing from Blockradar for user ${metadata.userId}: ${error.response ? JSON.stringify(error.response.data) : error.message}`);
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error withdrawing for user ${metadata.userId}: ${error.response ? JSON.stringify(error.response.data) : error.message}`, { parse_mode: 'Markdown' });
    throw error;
  }
}

// =================== Paycrest Order Creation Function ===================
async function createPaycrestOrder(userId, amount, token, chain, recipientDetails) {
  try {
    const paycrestMapping = mapToPaycrest(token, chain);
    if (!paycrestMapping) {
      throw new Error('No Paycrest mapping for the selected asset/chain.');
    }

    const bank = bankList.find(b => b.name.toLowerCase() === recipientDetails.bankName.toLowerCase());
    if (!bank || !bank.paycrestInstitutionCode) {
      const errorMsg = `No Paycrest institution code found for bank: ${recipientDetails.bankName}`;
      logger.error(errorMsg);
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ ${errorMsg} for user ${userId}.`);
      throw new Error(errorMsg);
    }

    const recipient = {
      institution: bank.paycrestInstitutionCode,
      accountIdentifier: recipientDetails.accountNumber,
      accountName: recipientDetails.accountName,
      memo: `Payment from DirectPay`,
      providerId: ""
    };

    const rate = exchangeRates[token];
    if (!rate) {
      throw new Error(`Exchange rate for ${token} not available.`);
    }

    const orderPayload = {
      amount: String(amount),
      rate: String(rate),
      network: paycrestMapping.network,
      token: paycrestMapping.token,
      recipient: recipient,
      returnAddress: PAYCREST_RETURN_ADDRESS,
      feePercent: 2,
    };

    const orderResp = await axios.post('https://api.paycrest.io/v1/sender/orders', orderPayload, {
      headers: {
        'API-Key': PAYCREST_API_KEY,
        'Content-Type': 'application/json'
      }
    });

    if (orderResp.data.status !== 'success') {
      throw new Error(`Paycrest order creation failed: ${orderResp.data.message}`);
    }

    const orderId = orderResp.data.data.id;
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🆕 *New Paycrest Order Created*\n\n` +
      `*User ID:* ${userId}\n` +
      `*Order ID:* ${orderId}\n` +
      `*Amount:* ${amount} ${token}\n` +
      `*Network:* ${paycrestMapping.network}\n` +
      `*Token:* ${paycrestMapping.token}\n` +
      `*Timestamp:* ${new Date().toLocaleString()}\n`, { parse_mode: 'Markdown' });
    
    logger.info(`Paycrest order created for user ${userId}: Order ID ${orderId}`);

    await logUserAction({ id: userId }, 'Create Paycrest Order', `Chain: ${chain}, Token: ${token}, Order ID: ${orderId}`);

    return orderResp.data.data;
  } catch (err) {
    logger.error(`Error creating Paycrest order: ${err.response ? err.response.data.message : err.message}`);
    throw new Error('Failed to create Paycrest order.');
  }
}

// =================== Telegram Webhook Setup ===================
(async () => {
  try {
    await bot.telegram.setWebhook(TELEGRAM_WEBHOOK_URL);
    logger.info(`Telegram webhook set to ${TELEGRAM_WEBHOOK_URL}`);
    
    await logUserAction({ id: 'Webhook Setup', username: 'N/A', first_name: 'N/A', last_name: 'N/A' }, 'Set Telegram Webhook', `Webhook URL: ${TELEGRAM_WEBHOOK_URL}`);
  } catch (error) {
    logger.error(`Failed to set Telegram webhook: ${error.message}`);
    process.exit(1);

    await logUserAction({ id: 'Webhook Setup', username: 'N/A', first_name: 'N/A', last_name: 'N/A' }, 'Set Telegram Webhook Failed', error.message);
  }
})();

app.post(TELEGRAM_WEBHOOK_PATH, (req, res) => {
  bot.handleUpdate(req.body, res);
});

// =================== Start Express Server ===================
const port = process.env.PORT || 4000;
app.listen(port, () => {
  logger.info(`Webhook server running on port ${port}`);

  logUserAction({ id: 'Server Start', username: 'N/A', first_name: 'N/A', last_name: 'N/A' }, 'Server Start', `Listening on port ${port}`);
});

// =================== Graceful Shutdown ===================
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
