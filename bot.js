const express = require('express');
const { Telegraf, Markup, Scenes, session } = require('telegraf');
const admin = require('firebase-admin');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const winston = require('winston');
const bodyParser = require('body-parser');
const sharp = require('sharp');
const requestIp = require('request-ip');
require('dotenv').config();

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

// Firebase Initialization
const serviceAccountPath = path.join(__dirname, 'directpay.json');
if (!fs.existsSync(serviceAccountPath)) {
  logger.error('Firebase service account file (directpay.json) not found.');
  process.exit(1);
}
const serviceAccount = require(serviceAccountPath);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://directpay9ja.firebaseio.com"
});
const db = admin.firestore();

// Environment Variables
const {
  BOT_TOKEN,
  PAYCREST_API_KEY,
  PAYCREST_CLIENT_SECRET,
  PAYCREST_RATE_API_URL = 'https://api.paycrest.io/v1/rates',
  PAYCREST_RETURN_ADDRESS = "0xYourReturnAddressHere",
  PERSONAL_CHAT_ID,
  PAYSTACK_API_KEY,
  ADMIN_IDS = '',
  WEBHOOK_PATH = '/webhook/telegram',
  WEBHOOK_PAYCREST_PATH = '/webhook/paycrest',
  WEBHOOK_BLOCKRADAR_PATH = '/webhook/blockradar',
  WEBHOOK_DOMAIN,
  PORT = 4000,
  BLOCKRADAR_BASE_API_KEY,
  BLOCKRADAR_BNB_API_KEY,
  BLOCKRADAR_POLYGON_API_KEY,
  MAX_WALLETS = 5,
} = process.env;

if (!BOT_TOKEN || !PAYCREST_API_KEY || !PAYCREST_CLIENT_SECRET || !WEBHOOK_DOMAIN || !PAYSTACK_API_KEY) {
  logger.error('Missing required environment variables. Please check your .env file.');
  process.exit(1);
}

const requiredKeys = [
  BLOCKRADAR_BASE_API_KEY,
  BLOCKRADAR_BNB_API_KEY,
  BLOCKRADAR_POLYGON_API_KEY,
  PERSONAL_CHAT_ID,
  ADMIN_IDS
];
for (const key of requiredKeys) {
  if (!key) {
    logger.error(`Missing required key: ${key}. Please update your .env file.`);
    process.exit(1);
  }
}

const WALLET_GENERATED_IMAGE = './images/wallet_generated_base.png';
const DEPOSIT_SUCCESS_IMAGE = './images/deposit_success.png';
const PAYOUT_SUCCESS_IMAGE = './images/payout_success.png';
const ERROR_IMAGE = './images/error.png';

const app = express();
const bot = new Telegraf(BOT_TOKEN);

// Bank List and Chain Configurations
const bankList = [
  { name: 'Access Bank', code: '044', aliases: ['access', 'access bank', 'accessb', 'access bank nigeria'], paycrestInstitutionCode: 'ABNGNGLA' },
  { name: 'Wema Bank', code: '035', aliases: ['wema', 'wema bank', 'wemab', 'wema bank nigeria'], paycrestInstitutionCode: 'WEMANGLA' },
  { name: 'Kuda Microfinance Bank', code: '50211', aliases: ['kuda', 'kuda bank', 'kudab', 'kuda bank nigeria'], paycrestInstitutionCode: 'KUDANGPC' },
  { name: 'OPay', code: '999992', aliases: ['opay', 'opay nigeria'], paycrestInstitutionCode: 'OPAYNGPC' },
  { name: 'PalmPay', code: '999991', aliases: ['palmpay', 'palmpay nigeria'], paycrestInstitutionCode: 'PALMNGPC' },
  { name: 'Paystack-Titan MFB', code: '999992', aliases: ['paystack', 'paystack mfb', 'paystack-titan mfb'], paycrestInstitutionCode: 'PAYTNGPC' },
  { name: 'Moniepoint MFB', code: '999993', aliases: ['moniepoint', 'moniepoint mfb', 'moniepoint nigeria'], paycrestInstitutionCode: 'MONINGPC' },
  { name: 'Safe Haven MFB', code: '999994', aliases: ['safe haven', 'safe haven mfb', 'safe haven nigeria'], paycrestInstitutionCode: 'SAHVNGPC' },
  { name: 'Zenith Bank', code: '057', aliases: ['zenith', 'zenith bank', 'zenithb', 'zenith bank nigeria'], paycrestInstitutionCode: 'ZENITHNGLA' },
  { name: 'GTBank', code: '058', aliases: ['gtbank', 'gt bank', 'gtb', 'gt bank nigeria'], paycrestInstitutionCode: 'GTBNGLA' },
  { name: 'First Bank of Nigeria', code: '011', aliases: ['first bank', 'first bank of nigeria', 'fbn', 'firstbank'], paycrestInstitutionCode: 'FBNNGLA' },
  { name: 'UBA', code: '032', aliases: ['uba', 'united bank for africa', 'uba nigeria'], paycrestInstitutionCode: 'UBANGPC' },
  { name: 'FCMB', code: '214', aliases: ['fcmb', 'first city monument bank', 'fcmb nigeria'], paycrestInstitutionCode: 'FCMBNGPC' },
];

const chains = {
  Base: {
    id: 'e31c44d6-0344-4ee1-bcd1-c88e89a9e3f1',
    key: BLOCKRADAR_BASE_API_KEY,
    apiUrl: 'https://api.blockradar.co/v1/wallets/e31c44d6-0344-4ee1-bcd1-c88e89a9e3f1/addresses',
    supportedAssets: ['USDC', 'USDT'],
    network: 'Base',
    assets: { USDC: 'a8aae94e-a2c3-424c-8db5-ea7415166ce3', USDT: 'a8aae94e-a2c3-424c-8db5-ea7415166ce3' }
  },
  Polygon: {
    id: 'f4fc4dc4-a0d5-4303-a60b-e58ec1fc6d0a',
    key: BLOCKRADAR_POLYGON_API_KEY,
    apiUrl: 'https://api.blockradar.co/v1/wallets/f4fc4dc4-a0d5-4303-a60b-e58ec1fc6d0a/addresses',
    supportedAssets: ['USDC', 'USDT'],
    network: 'Polygon',
    assets: { USDC: 'f348e8e3-e0b4-4704-857e-c274ef000c00', USDT: 'c9d57a33-375b-46f7-b694-16e9b498e0e1' }
  },
  'BNB Smart Chain': {
    id: '7a844e91-5740-4589-9695-c74411adec7e',
    key: BLOCKRADAR_BNB_API_KEY,
    apiUrl: 'https://api.blockradar.co/v1/wallets/7a844e91-5740-4589-9695-c74411adec7e/addresses',
    supportedAssets: ['USDT', 'USDC'],
    network: 'BNB Smart Chain',
    assets: { USDC: 'ff479231-0dbb-4760-b695-e219a50934af', USDT: '03a11a51-1422-4ac0-abc0-b2fed75e9fcb' }
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

// Utility Functions
function mapToPaycrest(asset, chainName) {
  if (!['USDC', 'USDT'].includes(asset)) return null;
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

function calculatePayoutWithFee(amount, rate, feePercent = 0.5) {
  const fee = (amount * rate) * (feePercent / 100);
  return parseFloat(((amount * rate) - fee).toFixed(2));
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
    throw new Error('Failed to verify bank account.');
  }
}

async function createPaycrestOrder(userId, amount, token, network, recipientDetails, userSendAddress) {
  try {
    const paycrestMapping = mapToPaycrest(token, network);
    if (!paycrestMapping) throw new Error('No Paycrest mapping for the selected asset/chain.');

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
    if (!rate) throw new Error(`Exchange rate for ${token} not available.`);

    const orderPayload = {
      amount: String(amount),
      rate: String(rate),
      network: paycrestMapping.network,
      token: paycrestMapping.token,
      recipient,
      returnAddress: userSendAddress || PAYCREST_RETURN_ADDRESS,
      feePercent: 2,
    };

    const orderResp = await axios.post('https://api.paycrest.io/v1/sender/orders', orderPayload, {
      headers: {
        'API-Key': PAYCREST_API_KEY,
        'Content-Type': 'application/json'
      }
    });

    if (orderResp.data.status !== 'success') throw new Error(`Paycrest order creation failed: ${orderResp.data.message}`);
    return orderResp.data.data;
  } catch (err) {
    logger.error(`Error creating Paycrest order: ${err.message}`);
    throw err;
  }
}

async function withdrawFromBlockradar(chain, assetId, address, amount, reference, metadata) {
  try {
    const chainKey = chainMapping[chain.toLowerCase()];
    if (!chainKey) throw new Error(`Unsupported or unknown chain: ${chain}`);

    const chainData = chains[chainKey];
    if (!chainData) throw new Error(`Chain data not found for: ${chainKey}`);

    const resp = await axios.post(`https://api.blockradar.co/v1/wallets/${chainData.id}/withdraw`, {
      address,
      amount: String(amount),
      assetId,
      reference,
      metadata
    }, {
      headers: {
        'x-api-key': chainData.key,
        'Content-Type': 'application/json'
      }
    });
    const data = resp.data;
    if (data.statusCode !== 200) throw new Error(`Blockradar withdrawal error: ${JSON.stringify(data)}`);
    return data;
  } catch (error) {
    logger.error(`Error withdrawing from Blockradar: ${error.message}`);
    throw error;
  }
}

async function getUserState(userId) {
  try {
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      const defaultState = {
        firstName: '',
        wallets: [],
        walletAddresses: [],
        hasReceivedDeposit: false,
        awaitingBroadcastMessage: false,
        usePidgin: false,
      };
      await db.collection('users').doc(userId).set(defaultState);
      logger.info(`Initialized default user state for ${userId}`);
      return defaultState;
    }
    const data = userDoc.data();
    return {
      firstName: data.firstName || '',
      wallets: data.wallets || [],
      walletAddresses: data.walletAddresses || [],
      hasReceivedDeposit: data.hasReceivedDeposit || false,
      awaitingBroadcastMessage: data.awaitingBroadcastMessage || false,
      usePidgin: data.usePidgin || false,
    };
  } catch (error) {
    logger.error(`Error fetching user state for ${userId}: ${error.message}`);
    return {
      firstName: '',
      wallets: [],
      walletAddresses: [],
      hasReceivedDeposit: false,
      awaitingBroadcastMessage: false,
      usePidgin: false,
    };
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
    if (!chainData) throw new Error(`Unsupported chain: ${chain}`);

    const response = await axios.post(
      chainData.apiUrl,
      { name: `DirectPay_User_Wallet_${chain}` },
      { headers: { 'x-api-key': chainData.key } }
    );

    const walletAddress = response.data.data.address;
    if (!walletAddress) throw new Error('Wallet address not returned from Blockradar.');
    return walletAddress;
  } catch (error) {
    logger.error(`Error generating wallet for ${chain}: ${error.message}`);
    throw error;
  }
}

// Define and register the bankLinkingScene
const bankLinkingScene = new Scenes.WizardScene(
  'bank_linking_scene',
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const walletIndex = ctx.session.walletIndex;

    logger.info(`Entering bank_linking_scene step 1 for user ${userId}, walletIndex: ${walletIndex}`);

    try {
      if (walletIndex === undefined || walletIndex === null) {
        const userState = await getUserState(userId);
        const errorMsg = userState.usePidgin
          ? '⚠️ No wallet dey here o! Click "💼 Generate Wallet" for menu to start.'
          : '⚠️ No wallet selected. Please click "💼 Generate Wallet" from the menu to start.';
        await ctx.replyWithMarkdown(errorMsg);
        logger.warn(`No walletIndex for user ${userId}, exiting scene`);
        return ctx.scene.leave();
      }

      logger.info(`Fetching user state for ${userId}`);
      const userState = await getUserState(userId);
      logger.info(`User state fetched for ${userId}: ${JSON.stringify(userState)}`);

      ctx.session.bankData = { step: 1 };
      const prompt = userState.usePidgin
        ? '🏦 Abeg enter your bank name (e.g., Access Bank), my friend:'
        : '🏦 Please enter your bank name (e.g., Access Bank):';

      try {
        await ctx.replyWithMarkdown(prompt);
        logger.info(`Bank name prompt sent to user ${userId}, session: ${JSON.stringify(ctx.session)}`);
      } catch (sendError) {
        logger.error(`Failed to send bank name prompt to user ${userId}: ${sendError.message}`);
        throw sendError;
      }

      logger.info(`Advancing to step 2 for user ${userId}`);
      return ctx.wizard.next();
    } catch (error) {
      logger.error(`Error in bank_linking_scene step 1 for user ${userId}: ${error.message}`);
      await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again.');
      return ctx.scene.leave();
    }
  },
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const input = ctx.message.text.trim();
    logger.info(`User ${userId} entered bank name: ${input}, session: ${JSON.stringify(ctx.session)}`);

    try {
      const userState = await getUserState(userId);
      const bankNameInput = input.toLowerCase();
      const bank = bankList.find((b) => b.aliases.includes(bankNameInput));

      if (!bank) {
        const errorMsg = userState.usePidgin
          ? '❌ Bank name no correct o! Abeg enter valid bank name from this list:\n\n' + bankList.map(b => `• ${b.name}`).join('\n')
          : '❌ Invalid bank name. Please enter a valid bank name from our supported list:\n\n' + bankList.map(b => `• ${b.name}`).join('\n');
        await ctx.replyWithMarkdown(errorMsg);
        return;
      }

      ctx.session.bankData.bankName = bank.name;
      ctx.session.bankData.bankCode = bank.code;
      ctx.session.bankData.step = 2;

      const prompt = userState.usePidgin
        ? '🔢 Enter your 10-digit account number. No dey waste time o, money dey wait!'
        : '🔢 Please enter your 10-digit bank account number:';
      await ctx.replyWithMarkdown(prompt);
      return ctx.wizard.next();
    } catch (error) {
      logger.error(`Error in bank_linking_scene step 2 for user ${userId}: ${error.message}`);
      const userState = await getUserState(userId);
      const errorMsg = userState.usePidgin
        ? '⚠️ Something no work o! Try again abeg.'
        : '⚠️ An error occurred. Please try again.';
      await ctx.replyWithMarkdown(errorMsg);
      return ctx.scene.leave();
    }
  },
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const input = ctx.message.text.trim();
    logger.info(`User ${userId} entered account number: ${input}, session: ${JSON.stringify(ctx.session)}`);

    try {
      const userState = await getUserState(userId);
      if (!/^\d{10}$/.test(input)) {
        const errorMsg = userState.usePidgin
          ? '❌ Account number no correct o! Abeg enter valid 10-digit number:'
          : '❌ Invalid account number. Please enter a valid 10-digit account number:';
        await ctx.replyWithMarkdown(errorMsg);
        return;
      }

      ctx.session.bankData.accountNumber = input;
      ctx.session.bankData.step = 3;

      const verifyingMsg = userState.usePidgin
        ? '🔄 Verifying your bank details... Relax, we dey check am like SARS dey check car papers!'
        : '🔄 Verifying your bank details...';
      await ctx.replyWithMarkdown(verifyingMsg);

      const verificationResult = await verifyBankAccount(ctx.session.bankData.accountNumber, ctx.session.bankData.bankCode);

      if (!verificationResult || !verificationResult.data) {
        throw new Error('Invalid verification response from Paystack.');
      }

      const accountName = verificationResult.data.account_name;
      if (!accountName) throw new Error('Unable to retrieve account name from Paystack.');

      ctx.session.bankData.accountName = accountName;
      ctx.session.bankData.step = 4;

      const confirmMsg = userState.usePidgin
        ? `🏦 *Bank Account Verification*\n\n` +
          `Please confirm your bank details:\n` +
          `- *Bank Name:* ${ctx.session.bankData.bankName}\n` +
          `- *Account Number:* ${ctx.session.bankData.accountNumber}\n` +
          `- *Account Holder:* ${accountName}\n\n` +
          `Na you be this abi na another person?`
        : `🏦 *Bank Account Verification*\n\n` +
          `Please confirm your bank details:\n` +
          `- *Bank Name:* ${ctx.session.bankData.bankName}\n` +
          `- *Account Number:* ${ctx.session.bankData.accountNumber}\n` +
          `- *Account Holder:* ${accountName}\n\n` +
          `Is this information correct?`;
      await ctx.replyWithMarkdown(confirmMsg, Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes, Confirm', 'confirm_bank_yes')],
        [Markup.button.callback('❌ No, Edit Details', 'confirm_bank_no')],
        [Markup.button.callback('❌ Cancel Linking', 'cancel_bank_linking')],
      ]));
      return ctx.wizard.next();
    } catch (error) {
      logger.error(`Error verifying bank account for user ${userId}: ${error.message}`);
      const userState = await getUserState(userId);
      const errorMsg = userState.usePidgin
        ? '❌ E no work o! Check your details well or try again later.'
        : '❌ Failed to verify your bank account. Please check your details or try again later.';
      await ctx.replyWithMarkdown(errorMsg);
      return ctx.scene.leave();
    }
  },
  async (ctx) => {
    return; // Placeholder for action handling
  }
);

// Register the scene with stage
const stage = new Scenes.Stage();
stage.register(bankLinkingScene);

// Apply session and stage middleware
bot.use(session({
  store: {
    get: async (key) => {
      const doc = await db.collection('sessions').doc(key).get();
      const data = doc.exists ? doc.data() : undefined;
      logger.info(`Session get for ${key}: ${JSON.stringify(data)}`);
      return data;
    },
    set: async (key, sess) => {
      await db.collection('sessions').doc(key).set(sess);
      logger.info(`Session set for ${key}: ${JSON.stringify(sess)}`);
    },
    delete: async (key) => {
      await db.collection('sessions').doc(key).delete();
      logger.info(`Session deleted for ${key}`);
    },
  },
}));
bot.use(stage.middleware());

// Exchange Rates
const SUPPORTED_ASSETS = ['USDC', 'USDT'];
let exchangeRates = { USDC: 0, USDT: 0 };

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
      if (isNaN(rate)) throw new Error(`Invalid rate data for ${asset}: ${response.data.data}`);
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
setInterval(fetchExchangeRates, 300000);

// Menu Functions
const getMainMenu = () =>
  Markup.keyboard([
    ['💼 Generate Wallet', '⚙️ Settings'],
    ['💰 Transactions', 'ℹ️ Support', '📘 Learn About Base'],
    ['📈 View Current Rates'],
  ]).resize();

const getWalletMenu = () =>
  Markup.keyboard([
    ['💼 View Wallet', '⚙️ Settings'],
    ['💰 Transactions', 'ℹ️ Support', '📘 Learn About Base'],
    ['📈 View Current Rates'],
  ]).resize();

const isAdmin = (userId) => ADMIN_IDS.split(',').map(id => id.trim()).includes(userId.toString());

// Bot Handlers
bot.start(async (ctx) => {
  try {
    await greetUser(ctx);
  } catch (error) {
    logger.error(`Error in /start command: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
  }
});

async function greetUser(ctx) {
  const userId = ctx.from.id.toString();
  try {
    let userState = await getUserState(userId);

    if (!userState.firstName && ctx.from.first_name) {
      await updateUserState(userId, { firstName: ctx.from.first_name });
      userState.firstName = ctx.from.first_name;
    }

    const greeting = userState.firstName
      ? `👋 Welcome, ${userState.firstName}!\n\nThank you for choosing **DirectPay**. Here, we convert your cryptocurrency to cash swiftly and securely. Let’s get started:`
      : `👋 Welcome, valued user!\n\nThank you for choosing **DirectPay**. Here, we convert your cryptocurrency to cash swiftly and securely. Let’s get started:`;
    const mainMenu = getMainMenu();
    await ctx.replyWithMarkdown(greeting, {
      reply_markup: mainMenu.reply_markup,
    });

    if (isAdmin(userId)) {
      const adminText = userState.firstName
        ? `Admin options, ${userState.firstName}:`
        : 'Admin options, esteemed user:';
      await ctx.reply(adminText, Markup.inlineKeyboard([
        [Markup.button.callback('🔧 Admin Panel', 'open_admin_panel')]
      ]));
    }
  } catch (error) {
    logger.error(`Error in greetUser for ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
  }
}

bot.hears(/^[Pp][Ii][Dd][Gg][Ii][Nn]$/, async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    await updateUserState(userId, { usePidgin: true });
    const userState = await getUserState(userId);
    const confirmMsg = userState.firstName
      ? `Ehen! ${userState.firstName}, we don switch to Pidgin for you o! Here’s your menu again, Naija style:`
      : `Ehen! We don switch to Pidgin for you o, my friend! Here’s your menu again, Naija style:`;
    const mainMenu = userState.wallets.length > 0 ? getWalletMenu() : getMainMenu();
    await ctx.replyWithMarkdown(confirmMsg, {
      reply_markup: mainMenu.reply_markup,
    });

    if (userState.wallets.length > 0) {
      ctx.session.walletIndex = userState.wallets.length - 1;
      await ctx.scene.enter('bank_linking_scene');
    }

    if (isAdmin(userId)) {
      const adminText = userState.firstName
        ? `Admin options, ${userState.firstName} the boss:`
        : `Admin options, big boss:`;
      await ctx.reply(adminText, Markup.inlineKeyboard([
        [Markup.button.callback('🔧 Admin Panel', 'open_admin_panel')]
      ]));
    }
  } catch (error) {
    logger.error(`Error switching to Pidgin for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again.');
  }
});

bot.hears('💼 Generate Wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    logger.info(`User ${userId} requested wallet generation`);
    const userState = await getUserState(userId);

    // Check wallet limit
    if (userState.wallets.length >= MAX_WALLETS) {
      const errorMsg = userState.usePidgin
        ? `⚠️ You don reach max wallets o (${MAX_WALLETS})! Manage the ones you get first abeg.`
        : `⚠️ You have reached the maximum number of wallets (${MAX_WALLETS}). Please manage your existing wallets.`;
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }

    // Show pending message
    const pendingMsg = userState.usePidgin
      ? '🔄 *Generating Wallet...* Hold small, we dey cook am hot-hot!'
      : '🔄 *Generating Wallet...* Please wait a moment!';
    const pendingMessage = await ctx.replyWithMarkdown(pendingMsg);

    // Generate wallet
    const chain = 'Base';
    const walletAddress = await generateWallet(chain);

    // Update user state
    const newWallet = {
      address: walletAddress,
      chain: chain,
      name: `Wallet ${userState.wallets.length + 1}`,
      supportedAssets: ['USDC', 'USDT'],
      bank: null,
      amount: 0,
      creationDate: new Date().toISOString(),
      totalDeposits: 0,
      totalPayouts: 0
    };
    userState.wallets.push(newWallet);
    userState.walletAddresses.push(walletAddress);
    await updateUserState(userId, {
      wallets: userState.wallets,
      walletAddresses: userState.walletAddresses,
    });

    // Clean up and confirm
    await ctx.deleteMessage(pendingMessage.message_id);
    const successMsg = userState.usePidgin
      ? `✅ *Wallet Don Land!*\n\n` +
        `*Address:* \`${walletAddress}\`\n` +
        `*Networks:* Base, BNB Smart Chain, Polygon\n` +
        `*Assets:* USDC, USDT\n\n` +
        `Abeg link your bank account now to start using am!`
      : `✅ *Wallet Generated Successfully!*\n\n` +
        `*Address:* \`${walletAddress}\`\n` +
        `*Networks:* Base, BNB Smart Chain, Polygon\n` +
        `*Assets:* USDC, USDT\n\n` +
        `Please link your bank account to start using it!`;
    await ctx.replyWithMarkdown(successMsg);

    // Enter bank linking scene immediately
    ctx.session.walletIndex = userState.wallets.length - 1;
    logger.info(`Entering bank_linking_scene for user ${userId}, walletIndex: ${ctx.session.walletIndex}`);
    await ctx.scene.enter('bank_linking_scene');

  } catch (error) {
    logger.error(`Error generating wallet for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '⚠️ Wahala dey o! Try again later abeg.'
      : '⚠️ An error occurred while generating your wallet. Please try again later.';
    await ctx.replyWithMarkdown(errorMsg);
  }
});

bot.hears('💼 View Wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    
    if (userState.wallets.length === 0) {
      const errorMsg = userState.usePidgin
        ? '❌ You no get wallet o! Click "💼 Generate Wallet" for menu to start.'
        : '❌ You have no wallets. Click "💼 Generate Wallet" from the menu to start.';
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }

    let message = userState.usePidgin
      ? `💼 *Your Wallets* 💰\n\n`
      : `💼 *Your Wallets* 💰\n\n`;
    userState.wallets.forEach((wallet, index) => {
      message += `🌟 *${wallet.name || `Wallet #${index + 1}`}*\n` +
        `🔹 *Address:* \`${wallet.address}\`\n` +
        `🔹 *Network:* ${wallet.chain}\n` +
        `🔹 *Bank Linked:* ${wallet.bank ? '✅ Yes' : '❌ No'}\n` +
        (wallet.bank ? `🔹 *Bank Details:*\n` +
          `   - 🏦 *Bank:* ${wallet.bank.bankName}\n` +
          `   - 💳 *Account:* ****${wallet.bank.accountNumber.slice(-4)}\n` +
          `   - 👤 *Holder:* ${wallet.bank.accountName}\n` : '') +
        `🔹 *Creation Date:* ${new Date(wallet.creationDate).toLocaleString()}\n\n`;
    });

    await ctx.replyWithMarkdown(message, Markup.inlineKeyboard(
      userState.wallets.map((wallet, index) => [
        [Markup.button.callback('👀 View', `view_wallet_${index}`), Markup.button.callback('✏️ Rename', `rename_wallet_${index}`)],
        [Markup.button.callback('🏦 Edit Bank', `edit_bank_${index}`), Markup.button.callback('🗑️ Delete', `delete_wallet_${index}`)]
      ]).flat()
    ));
  } catch (error) {
    logger.error(`Error in View Wallet for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '⚠️ E no work o! Try again later abeg.'
      : '⚠️ An error occurred while fetching your wallets. Please try again later.';
    await ctx.replyWithMarkdown(errorMsg);
  }
});

bot.action(/view_wallet_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);

  try {
    const userState = await getUserState(userId);
    if (walletIndex < 0 || walletIndex >= userState.wallets.length) {
      const errorMsg = userState.usePidgin
        ? '❌ Wallet no dey o! Pick correct one abeg.'
        : '❌ Invalid wallet selection. Please choose a valid wallet.';
      await ctx.replyWithMarkdown(errorMsg);
      await ctx.answerCbQuery();
      return;
    }

    const wallet = userState.wallets[walletIndex];
    const message = userState.usePidgin
      ? `🌟 *${wallet.name || `Wallet #${walletIndex + 1}`}*\n\n` +
        `🔹 *Address:* \`${wallet.address}\`\n` +
        `🔹 *Network:* ${wallet.chain}\n` +
        `🔹 *Supported Assets:*\n` +
        `   - ✅ USDC\n` +
        `   - ✅ USDT\n` +
        `🔹 *Bank Linked:* ${wallet.bank ? '✅ Yes' : '❌ No'}\n` +
        (wallet.bank ? `🔹 *Bank Details:*\n` +
          `   - 🏦 *Bank:* ${wallet.bank.bankName}\n` +
          `   - 💳 *Account:* ****${wallet.bank.accountNumber.slice(-4)}\n` +
          `   - 👤 *Holder:* ${wallet.bank.accountName}\n` : '') +
        `🔹 *Creation Date:* ${new Date(wallet.creationDate).toLocaleString()}\n` +
        `🔹 *Total Deposits:* ${wallet.totalDeposits || 0} USDC/USDT\n` +
        `🔹 *Total Payouts:* ₦${wallet.totalPayouts || 0}`
      : `🌟 *${wallet.name || `Wallet #${walletIndex + 1}`}*\n\n` +
        `🔹 *Address:* \`${wallet.address}\`\n` +
        `🔹 *Network:* ${wallet.chain}\n` +
        `🔹 *Supported Assets:*\n` +
        `   - ✅ USDC\n` +
        `   - ✅ USDT\n` +
        `🔹 *Bank Linked:* ${wallet.bank ? '✅ Yes' : '❌ No'}\n` +
        (wallet.bank ? `🔹 *Bank Details:*\n` +
          `   - 🏦 *Bank:* ${wallet.bank.bankName}\n` +
          `   - 💳 *Account:* ****${wallet.bank.accountNumber.slice(-4)}\n` +
          `   - 👤 *Holder:* ${wallet.bank.accountName}\n` : '') +
        `🔹 *Creation Date:* ${new Date(wallet.creationDate).toLocaleString()}\n` +
        `🔹 *Total Deposits:* ${wallet.totalDeposits || 0} USDC/USDT\n` +
        `🔹 *Total Payouts:* ₦${wallet.totalPayouts || 0}`;

    await ctx.replyWithMarkdown(message);
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in view_wallet for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again.');
    await ctx.answerCbQuery();
  }
});

bot.action(/rename_wallet_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);

  try {
    const userState = await getUserState(userId);
    if (walletIndex < 0 || walletIndex >= userState.wallets.length) {
      const errorMsg = userState.usePidgin
        ? '❌ Wallet no dey o! Pick correct one abeg.'
        : '❌ Invalid wallet selection. Please choose a valid wallet.';
      await ctx.replyWithMarkdown(errorMsg);
      await ctx.answerCbQuery();
      return;
    }

    const prompt = userState.usePidgin
      ? `Abeg enter new name for this wallet (e.g., "My Main Wallet"):`
      : `Please enter a new name for this wallet (e.g., "My Main Wallet"):`;
    await ctx.replyWithMarkdown(prompt);
    ctx.session.awaitingRename = walletIndex;
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in rename_wallet for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again.');
    await ctx.answerCbQuery();
  }
});

bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  let userState;

  try {
    userState = await getUserState(userId);
  } catch (error) {
    logger.error(`Failed to get user state in text handler for ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
    return;
  }

  if (ctx.session.awaitingRename !== undefined) {
    try {
      const walletIndex = ctx.session.awaitingRename;
      const newName = ctx.message.text.trim();

      if (walletIndex < 0 || walletIndex >= userState.wallets.length) {
        const errorMsg = userState.usePidgin
          ? '❌ Wallet no dey o! Try again abeg.'
          : '❌ Invalid wallet. Please try again.';
        await ctx.replyWithMarkdown(errorMsg);
        delete ctx.session.awaitingRename;
        return;
      }

      if (!newName) {
        const errorMsg = userState.usePidgin
          ? '❌ Name no fit empty o! Enter something abeg.'
          : '❌ Name cannot be empty. Please enter a valid name.';
        await ctx.replyWithMarkdown(errorMsg);
        return;
      }

      userState.wallets[walletIndex].name = newName;
      await updateUserState(userId, { wallets: userState.wallets });

      const successMsg = userState.usePidgin
        ? `✅ Wallet don rename to "${newName}" o!`
        : `✅ Wallet renamed to "${newName}" successfully!`;
      await ctx.replyWithMarkdown(successMsg);
      delete ctx.session.awaitingRename;
    } catch (error) {
      logger.error(`Error renaming wallet for user ${userId}: ${error.message}`);
      const userState = await getUserState(userId);
      const errorMsg = userState.usePidgin
        ? '⚠️ E no work o! Try again abeg.'
        : '⚠️ An error occurred while renaming. Please try again.';
      await ctx.replyWithMarkdown(errorMsg);
      delete ctx.session.awaitingRename;
    }
  }

  if (ctx.session.awaitingAdminMessage) {
    try {
      if (!isAdmin(userId)) {
        const errorMsg = userState.usePidgin ? '⚠️ You no fit do this o! Admin only!' : '⚠️ You can’t do this! Admin only!';
        await ctx.replyWithMarkdown(errorMsg);
        delete ctx.session.awaitingAdminMessage;
        return;
      }

      const [targetUserId, ...messageParts] = ctx.message.text.trim().split(' ');
      const message = messageParts.join(' ');
      if (!targetUserId || !message) {
        const errorMsg = userState.usePidgin ? '❌ Format no correct o! Use: `<userId> <message>`' : '❌ Incorrect format! Use: `<userId> <message>`';
        await ctx.replyWithMarkdown(errorMsg);
        return;
      }

      await bot.telegram.sendMessage(targetUserId, message, { parse_mode: 'Markdown' });
      const successMsg = userState.usePidgin ? `✅ Message don send to User ${targetUserId} o!` : `✅ Message sent to User ${targetUserId} successfully!`;
      await ctx.replyWithMarkdown(successMsg);
      delete ctx.session.awaitingAdminMessage;
    } catch (error) {
      logger.error(`Error sending admin message for user ${userId}: ${error.message}`);
      const errorMsg = userState.usePidgin ? '⚠️ E no work o! Check User ID or try again abeg.' : '⚠️ An error occurred! Check User ID or try again.';
      await ctx.replyWithMarkdown(errorMsg);
      delete ctx.session.awaitingAdminMessage;
    }
  }

  if (userState.awaitingBroadcastMessage) {
    try {
      if (!isAdmin(userId)) {
        const errorMsg = userState.usePidgin ? '⚠️ You no fit do this o! Admin only!' : '⚠️ You can’t do this! Admin only!';
        await ctx.replyWithMarkdown(errorMsg);
        await updateUserState(userId, { awaitingBroadcastMessage: false });
        return;
      }

      const broadcastMessage = ctx.message.text.trim();
      const usersSnapshot = await db.collection('users').get();
      let successCount = 0;
      for (const doc of usersSnapshot.docs) {
        try {
          await bot.telegram.sendMessage(doc.id, broadcastMessage, { parse_mode: 'Markdown' });
          successCount++;
        } catch (err) {
          logger.warn(`Failed to send broadcast to user ${doc.id}: ${err.message}`);
        }
      }

      const successMsg = userState.usePidgin ? `📢 Broadcast don send to ${successCount} users o!` : `📢 Broadcast sent to ${successCount} users successfully!`;
      await ctx.replyWithMarkdown(successMsg);
      await updateUserState(userId, { awaitingBroadcastMessage: false });
    } catch (error) {
      logger.error(`Error broadcasting message for user ${userId}: ${error.message}`);
      const errorMsg = userState.usePidgin ? '⚠️ E no work o! Try again abeg.' : '⚠️ An error occurred during broadcast. Please try again.';
      await ctx.replyWithMarkdown(errorMsg);
      await updateUserState(userId, { awaitingBroadcastMessage: false });
    }
  }
});

bot.action(/edit_bank_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);

  try {
    const userState = await getUserState(userId);
    if (walletIndex < 0 || walletIndex >= userState.wallets.length) {
      const errorMsg = userState.usePidgin
        ? '❌ Wallet no dey o! Pick correct one abeg.'
        : '❌ Invalid wallet selection. Please choose a valid wallet.';
      await ctx.replyWithMarkdown(errorMsg);
      await ctx.answerCbQuery();
      return;
    }

    ctx.session.walletIndex = walletIndex;
    logger.info(`Entering bank_linking_scene for editing bank, user ${userId}, walletIndex: ${walletIndex}`);
    await ctx.scene.enter('bank_linking_scene');
    logger.info(`Successfully entered bank_linking_scene for editing, user ${userId}`);
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in edit_bank for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again.');
    await ctx.answerCbQuery();
  }
});

bot.action(/delete_wallet_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);

  try {
    const userState = await getUserState(userId);
    if (walletIndex < 0 || walletIndex >= userState.wallets.length) {
      const errorMsg = userState.usePidgin
        ? '❌ Wallet no dey o! Pick correct one abeg.'
        : '❌ Invalid wallet selection. Please choose a valid wallet.';
      await ctx.replyWithMarkdown(errorMsg);
      await ctx.answerCbQuery();
      return;
    }

    const wallet = userState.wallets[walletIndex];
    userState.wallets.splice(walletIndex, 1);
    userState.walletAddresses = userState.wallets.map(w => w.address); // Update walletAddresses
    await updateUserState(userId, { wallets: userState.wallets, walletAddresses: userState.walletAddresses });

    const successMsg = userState.usePidgin
      ? `🗑️ Wallet "${wallet.name || `Wallet #${walletIndex + 1}`}" don delete o!`
      : `🗑️ Wallet "${wallet.name || `Wallet #${walletIndex + 1}`}" has been deleted successfully!`;
    await ctx.replyWithMarkdown(successMsg);
    await ctx.answerCbQuery();

    if (userState.wallets.length === 0) {
      const mainMenu = getMainMenu();
      const menuText = userState.usePidgin
        ? 'No wallets remain o! Here’s your main menu:'
        : 'No wallets remaining! Here’s your main menu:';
      await ctx.replyWithMarkdown(menuText, { reply_markup: mainMenu.reply_markup });
    } else {
      await bot.hears('💼 View Wallet')(ctx);
    }
  } catch (error) {
    logger.error(`Error in delete_wallet for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while deleting the wallet. Please try again.');
    await ctx.answerCbQuery();
  }
});

bot.hears('⚙️ Settings', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    const menuText = userState.usePidgin
      ? '⚙️ *Settings Menu*'
      : '⚙️ *Settings Menu*';
    await ctx.replyWithMarkdown(menuText, Markup.inlineKeyboard([
      [Markup.button.callback(userState.usePidgin ? '🔄 Generate New Wallet' : '🔄 Generate New Wallet', 'settings_generate_wallet')],
      [Markup.button.callback(userState.usePidgin ? '💬 Support' : '💬 Support', 'settings_support')],
      [Markup.button.callback(userState.usePidgin ? '🔙 Back to Menu' : '🔙 Back to Main Menu', 'settings_back_main')]
    ]));
  } catch (error) {
    logger.error(`Error in settings handler for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '⚠️ E no work o! Try again abeg.'
      : '⚠️ An error occurred in settings. Please try again.';
    await ctx.replyWithMarkdown(errorMsg);
  }
});

bot.action('settings_generate_wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    await bot.hears('💼 Generate Wallet')(ctx);
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in settings_generate_wallet for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '⚠️ E no work o! Try again abeg.'
      : '⚠️ An error occurred. Please try again.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
  }
});

bot.action('settings_support', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    const supportMsg = userState.usePidgin
      ? '🛠️ *Support*\n\nNeed help? Contact us at [@maxcswap](https://t.me/maxcswap) anytime o!'
      : '🛠️ *Support*\n\nNeed assistance? Reach out to us at [@maxcswap](https://t.me/maxcswap) anytime!';
    await ctx.replyWithMarkdown(supportMsg);
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in settings_support for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again.');
    await ctx.answerCbQuery();
  }
});

bot.action('settings_back_main', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    const mainMenu = userState.wallets.length > 0 ? getWalletMenu() : getMainMenu();
    const menuText = userState.usePidgin
      ? userState.firstName ? `Welcome back to the menu, ${userState.firstName} wey sabi!` : 'Welcome back to the menu, my friend!'
      : userState.firstName ? `Welcome back to the menu, ${userState.firstName}!` : 'Welcome back to the menu!';
    await ctx.replyWithMarkdown(menuText, {
      reply_markup: mainMenu.reply_markup,
    });

    if (isAdmin(userId)) {
      const adminText = userState.usePidgin
        ? userState.firstName ? `Admin options, ${userState.firstName} the boss:` : 'Admin options, big boss:'
        : userState.firstName ? `Admin options, ${userState.firstName}:` : 'Admin options, esteemed user:';
      await ctx.reply(adminText, Markup.inlineKeyboard([[Markup.button.callback('🔧 Admin Panel', 'open_admin_panel')]]));
    }
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in settings_back_main for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again.');
    await ctx.answerCbQuery();
  }
});

bot.hears(/ℹ️\s*Support/i, async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    const supportMsg = userState.usePidgin
      ? '🛠️ *Support*\n\nNeed help? Contact us at [@maxcswap](https://t.me/maxcswap) anytime o!'
      : '🛠️ *Support*\n\nNeed assistance? Reach out to us at [@maxcswap](https://t.me/maxcswap) anytime!';
    await ctx.replyWithMarkdown(supportMsg);
  } catch (error) {
    logger.error(`Error in support handler for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '⚠️ E no work o! Try again abeg.'
      : '⚠️ An error occurred. Please try again.';
    await ctx.replyWithMarkdown(errorMsg);
  }
});

bot.hears(/📘\s*Learn About Base/i, async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    const baseMsg = userState.usePidgin
      ? '📘 *Learn About Base*\n\nBase na secure, cheap Ethereum Layer 2 network wey make decentralized apps easy to use. Check [Base Docs](https://docs.base.org) for more gist!'
      : '📘 *Learn About Base*\n\nBase is a secure, low-cost Ethereum Layer 2 network that simplifies using decentralized apps. Visit [Base Docs](https://docs.base.org) for more details!';
    await ctx.replyWithMarkdown(baseMsg);
  } catch (error) {
    logger.error(`Error in learn about base handler for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '⚠️ E no work o! Try again abeg.'
      : '⚠️ An error occurred. Please try again.';
    await ctx.replyWithMarkdown(errorMsg);
  }
});

async function transactionsHandler(ctx) {
  const userId = ctx.from.id.toString();
  const pageSize = 5;
  let page = ctx.session.transactionsPage || 1;
  let filter = ctx.session.transactionsFilter || 'all';
  let asset = ctx.session.transactionsAsset || 'All';
  const filterOptions = ['All', 'Pending', 'Failed', 'Completed'];
  const assetOptions = ['USDC', 'USDT', 'All'];

  try {
    const userState = await getUserState(userId);
    let query = db.collection('transactions').where('userId', '==', userId).orderBy('timestamp', 'desc');
    
    if (filter !== 'All') {
      query = query.where('status', '==', filter);
    }
    
    if (asset !== 'All') {
      query = query.where('asset', '==', asset);
    }

    const transactionsSnapshot = await query.limit(pageSize * page).get();
    const transactionsCount = transactionsSnapshot.size;
    const transactions = transactionsSnapshot.docs.slice((page - 1) * pageSize, page * pageSize);
    
    let message = userState.usePidgin
      ? `💰 *Transaction History* (Page ${page}) 💸\n\n`
      : `💰 *Transaction History* (Page ${page}) 💸\n\n`;
    if (transactions.length === 0) {
      message += userState.usePidgin
        ? 'No transactions dey here o!'
        : 'No transactions found!';
    } else {
      transactions.forEach((doc, index) => {
        const tx = doc.data();
        message += `🌟 *Transaction #${(page - 1) * pageSize + index + 1}*\n` +
          `🔹 *Reference ID:* \`${tx.referenceId}\`\n` +
          `🔹 *Status:* ${tx.status === 'Completed' ? '✅ Completed' : tx.status === 'Pending' ? '⏳ Pending' : '❌ Failed'}\n` +
          `🔹 *Deposit Amount:* ${tx.amount} ${tx.asset}\n` +
          `🔹 *Network:* ${tx.chain}\n` +
          `🔹 *Exchange Rate:* ₦${tx.blockradarRate || 'N/A'}/${tx.asset} (At Transaction Time)\n` +
          `🔹 *Payout Amount:* ₦${tx.payout || 'N/A'}\n` +
          `🔹 *Bank Details:*\n` +
          `   - 🏦 *Bank:* ${tx.bankDetails.bankName}\n` +
          `   - 💳 *Account:* ****${tx.bankDetails.accountNumber.slice(-4)}\n` +
          `   - 👤 *Holder:* ${tx.bankDetails.accountName}\n` +
          `🔹 *Timestamp:* ${new Date(tx.timestamp).toLocaleString()}\n` +
          `🔹 *Tx Hash:* \`${tx.transactionHash}\`\n\n`;
      });
    }

    const totalPages = Math.ceil(transactionsCount / pageSize);
    const navigationButtons = [
      Markup.button.callback('⬅️ Previous', `transactions_page_${Math.max(1, page - 1)}_${filter}_${asset}`, page === 1),
      Markup.button.callback('Next ➡️', `transactions_page_${Math.min(totalPages + 1, page + 1)}_${filter}_${asset}`, page >= totalPages),
      Markup.button.callback('🔄 Refresh', `transactions_page_${page}_${filter}_${asset}`),
      Markup.button.callback('🧹 Clear Wallet Filter', 'transactions_clear_filter')
    ];

    const filterButtons = filterOptions.map(status => 
      Markup.button.callback(status, `transactions_filter_${status}_${asset}`)
    );
    const assetButtons = assetOptions.map(assetOption => 
      Markup.button.callback(assetOption, `transactions_filter_${filter}_${assetOption}`)
    );

    await ctx.replyWithMarkdown(message, Markup.inlineKeyboard([
      navigationButtons,
      filterButtons,
      assetButtons
    ]));

    ctx.session.transactionsPage = page;
    ctx.session.transactionsFilter = filter;
    ctx.session.transactionsAsset = asset;
  } catch (error) {
    logger.error(`Error in transactionsHandler for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '⚠️ E no work o! Try again later abeg.'
      : '⚠️ An error occurred while fetching transactions. Please try again later.';
    await ctx.replyWithMarkdown(errorMsg);
  }
}

bot.hears(/💰\s*Transactions/i, transactionsHandler);

bot.action(/transactions_page_(\d+)_([^_]+)_([^_]+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    ctx.session.transactionsPage = parseInt(ctx.match[1], 10);
    ctx.session.transactionsFilter = ctx.match[2];
    ctx.session.transactionsAsset = ctx.match[3];
    await ctx.answerCbQuery();
    await transactionsHandler(ctx);
  } catch (error) {
    logger.error(`Error in transactions_page for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again.');
    await ctx.answerCbQuery();
  }
});

bot.action(/transactions_filter_([^_]+)_([^_]+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    ctx.session.transactionsFilter = ctx.match[1];
    ctx.session.transactionsAsset = ctx.match[2];
    ctx.session.transactionsPage = 1;
    await ctx.answerCbQuery();
    await transactionsHandler(ctx);
  } catch (error) {
    logger.error(`Error in transactions_filter for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again.');
    await ctx.answerCbQuery();
  }
});

bot.action('transactions_clear_filter', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    ctx.session.transactionsFilter = 'all';
    ctx.session.transactionsAsset = 'All';
    ctx.session.transactionsPage = 1;
    await ctx.answerCbQuery();
    await transactionsHandler(ctx);
  } catch (error) {
    logger.error(`Error in transactions_clear_filter for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again.');
    await ctx.answerCbQuery();
  }
});

bot.action('open_admin_panel', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    if (!isAdmin(userId)) {
      const errorMsg = userState.usePidgin
        ? '⚠️ You no be admin o! Only big bosses fit enter this panel.'
        : '⚠️ You’re not an admin! Only authorized users can access this panel.';
      await ctx.replyWithMarkdown(errorMsg);
      await ctx.answerCbQuery();
      return;
    }

    ctx.session.adminMessageId = null;

    const menuText = userState.usePidgin
      ? `👨‍💼 **Admin Panel**\n\nSelect an option below, ${userState.firstName || 'Oga'} the boss:`
      : `👨‍💼 **Admin Panel**\n\nSelect an option below, ${userState.firstName || 'esteemed user'}:`;
    const sentMessage = await ctx.replyWithMarkdown(menuText, Markup.inlineKeyboard([
      [Markup.button.callback('📋 View Recent Transactions', 'admin_view_transactions')],
      [Markup.button.callback('📨 Send Message to User', 'admin_send_message')],
      [Markup.button.callback('✅ Mark Transactions as Paid', 'admin_mark_paid')],
      [Markup.button.callback('👥 View All Users', 'admin_view_users')],
      [Markup.button.callback('📢 Broadcast Message', 'admin_broadcast_message')],
      [Markup.button.callback('🔙 Back to Main Menu', 'admin_back_to_main')],
    ]));
    ctx.session.adminMessageId = sentMessage.message_id;
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in open_admin_panel for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again.');
    await ctx.answerCbQuery();
  }
});

bot.action(/admin_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    if (!isAdmin(userId)) {
      const errorMsg = userState.usePidgin
        ? '⚠️ You no fit enter here o! Admin only zone.'
        : '⚠️ You can’t access this! Admin-only zone.';
      await ctx.replyWithMarkdown(errorMsg);
      await ctx.answerCbQuery();
      return;
    }

    const action = ctx.match[1];
    let message;

    switch (action) {
      case 'view_transactions':
        const transactionsSnapshot = await db.collection('transactions')
          .orderBy('timestamp', 'desc')
          .limit(5)
          .get();
        message = userState.usePidgin
          ? '📋 *Recent Transactions*\n\n'
          : '📋 *Recent Transactions*\n\n';
        if (transactionsSnapshot.empty) {
          message += userState.usePidgin ? 'No transactions dey o!' : 'No transactions found!';
        } else {
          transactionsSnapshot.forEach((doc, index) => {
            const tx = doc.data();
            message += `🌟 *Transaction #${index + 1}*\n` +
              `🔹 *User ID:* ${tx.userId}\n` +
              `🔹 *Status:* ${tx.status}\n` +
              `🔹 *Amount:* ${tx.amount} ${tx.asset}\n` +
              `🔹 *Payout:* ₦${tx.payout || 'N/A'}\n` +
              `🔹 *Timestamp:* ${new Date(tx.timestamp).toLocaleString()}\n\n`;
          });
        }
        break;

      case 'send_message':
        message = userState.usePidgin
          ? '📨 *Send Message to User*\n\nAbeg enter the User ID and message like this: `<userId> <message>` (e.g., "12345 Hello, how you dey?")'
          : '📨 *Send Message to User*\n\nPlease enter the User ID and message in this format: `<userId> <message>` (e.g., "12345 Hello, how are you?")';
        ctx.session.awaitingAdminMessage = true;
        break;

      case 'mark_paid':
        const pendingTxSnapshot = await db.collection('transactions')
          .where('status', '==', 'Pending')
          .limit(5)
          .get();
        message = userState.usePidgin
          ? '✅ *Pending Transactions to Mark Paid*\n\n'
          : '✅ *Pending Transactions to Mark Paid*\n\n';
        if (pendingTxSnapshot.empty) {
          message += userState.usePidgin ? 'No pending transactions dey o!' : 'No pending transactions found!';
        } else {
          const buttons = [];
          pendingTxSnapshot.forEach((doc) => {
            const tx = doc.data();
            message += `🌟 *Ref: ${tx.referenceId}*\n` +
              `🔹 *User ID:* ${tx.userId}\n` +
              `🔹 *Amount:* ${tx.amount} ${tx.asset}\n` +
              `🔹 *Payout:* ₦${tx.payout}\n\n`;
            buttons.push([Markup.button.callback(`Mark ${tx.referenceId} Paid`, `mark_tx_paid_${doc.id}`)]);
          });
          await ctx.replyWithMarkdown(message, Markup.inlineKeyboard(buttons));
          await ctx.answerCbQuery();
          return;
        }
        break;

      case 'view_users':
        const usersSnapshot = await db.collection('users').limit(5).get();
        message = userState.usePidgin
          ? '👥 *All Users*\n\n'
          : '👥 *All Users*\n\n';
        if (usersSnapshot.empty) {
          message += userState.usePidgin ? 'No users dey o!' : 'No users found!';
        } else {
          usersSnapshot.forEach((doc, index) => {
            const user = doc.data();
            message += `🌟 *User #${index + 1}*\n` +
              `🔹 *ID:* ${doc.id}\n` +
              `🔹 *Name:* ${user.firstName || 'N/A'}\n` +
              `🔹 *Wallets:* ${user.wallets.length}\n\n`;
          });
        }
        break;

      case 'broadcast_message':
        message = userState.usePidgin
          ? '📢 *Broadcast Message*\n\nAbeg type the message wey you wan send to all users:'
          : '📢 *Broadcast Message*\n\nPlease type the message you want to send to all users:';
        await updateUserState(userId, { awaitingBroadcastMessage: true });
        break;

      case 'back_to_main':
        const mainMenu = userState.wallets.length > 0 ? getWalletMenu() : getMainMenu();
        const menuText = userState.usePidgin
          ? userState.firstName ? `Welcome back to the menu, ${userState.firstName} wey sabi!` : 'Welcome back to the menu, my friend!'
          : userState.firstName ? `Welcome back to the menu, ${userState.firstName}!` : 'Welcome back to the menu!';
        await ctx.replyWithMarkdown(menuText, { reply_markup: mainMenu.reply_markup });
        if (isAdmin(userId)) {
          const adminText = userState.usePidgin
            ? userState.firstName ? `Admin options, ${userState.firstName} the boss:` : 'Admin options, big boss:'
            : userState.firstName ? `Admin options, ${userState.firstName}:` : 'Admin options, esteemed user:';
          await ctx.reply(adminText, Markup.inlineKeyboard([[Markup.button.callback('🔧 Admin Panel', 'open_admin_panel')]]));
        }
        await ctx.answerCbQuery();
        return;

      default:
        message = userState.usePidgin ? '❌ Option no dey o! Try again abeg.' : '❌ Invalid option! Please try again.';
    }

    if (ctx.session.adminMessageId) {
      await ctx.telegram.editMessageText(userId, ctx.session.adminMessageId, undefined, message, { parse_mode: 'Markdown' });
    } else {
      const sentMessage = await ctx.replyWithMarkdown(message);
      ctx.session.adminMessageId = sentMessage.message_id;
    }
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in admin_${action} for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again.');
    await ctx.answerCbQuery();
  }
});

bot.action(/mark_tx_paid_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const txId = ctx.match[1];
  try {
    const userState = await getUserState(userId);
    if (!isAdmin(userId)) {
      const errorMsg = userState.usePidgin
        ? '⚠️ You no fit do this o! Admin only!'
        : '⚠️ You can’t do this! Admin only!';
      await ctx.replyWithMarkdown(errorMsg);
      await ctx.answerCbQuery();
      return;
    }

    const txRef = db.collection('transactions').doc(txId);
    const txDoc = await txRef.get();
    if (!txDoc.exists) {
      const errorMsg = userState.usePidgin
        ? '❌ Transaction no dey o!'
        : '❌ Transaction not found!';
      await ctx.replyWithMarkdown(errorMsg);
      await ctx.answerCbQuery();
      return;
    }

    await txRef.update({ status: 'Completed', updatedAt: new Date().toISOString() });
    const successMsg = userState.usePidgin
      ? `✅ Transaction ${txDoc.data().referenceId} don mark as paid o!`
      : `✅ Transaction ${txDoc.data().referenceId} marked as paid successfully!`;
    await ctx.replyWithMarkdown(successMsg);
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in mark_tx_paid for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again.');
    await ctx.answerCbQuery();
  }
});

// Webhook Handlers
app.use(bodyParser.json());
app.use(requestIp.mw());

app.post(WEBHOOK_PATH, (req, res) => {
  bot.handleUpdate(req.body);
  res.sendStatus(200);
});

app.post(WEBHOOK_PAYCREST_PATH, async (req, res) => {
  try {
    const { event, data } = req.body;
    logger.info(`Paycrest Webhook Event: ${event}`, data);

    if (event === 'order.completed') {
      const userId = data.metadata.userId;
      const userState = await getUserState(userId);
      const payoutAmount = calculatePayoutWithFee(data.amount, data.rate);

      const txData = {
        userId,
        referenceId: data.orderId,
        status: 'Completed',
        amount: parseFloat(data.amount),
        asset: data.token,
        chain: data.network,
        payout: payoutAmount,
        bankDetails: data.recipient,
        timestamp: new Date().toISOString(),
        transactionHash: data.transactionHash,
        blockradarRate: data.rate,
      };

      await db.collection('transactions').add(txData);
      const successMsg = userState.usePidgin
        ? `🎉 *Payout Successful!*\n\n` +
          `You don cash out *${payoutAmount} NGN* to your bank account wey end with *${data.recipient.accountIdentifier.slice(-4)}*. Check your account sharp-sharp!`
        : `🎉 *Payout Successful!*\n\n` +
          `You’ve successfully cashed out *${payoutAmount} NGN* to your bank account ending in *${data.recipient.accountIdentifier.slice(-4)}*. Check your account now!`;
      await bot.telegram.sendPhoto(userId, { source: PAYOUT_SUCCESS_IMAGE }, {
        caption: successMsg,
        parse_mode: 'Markdown',
      });
    }

    res.status(200).json({ status: 'success' });
  } catch (error) {
    logger.error(`Error in Paycrest webhook: ${error.message}`);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.post(WEBHOOK_BLOCKRADAR_PATH, async (req, res) => {
  try {
    const { type, data } = req.body;
    logger.info(`Blockradar Webhook Event: ${type}`, data);

    if (type === 'deposit') {
      const userDoc = (await db.collection('users')
        .where('walletAddresses', 'array-contains', data.address)
        .get()).docs[0];

      if (!userDoc) {
        logger.warn(`No user found for wallet address: ${data.address}`);
        return res.status(404).json({ status: 'error', message: 'User not found' });
      }

      const userId = userDoc.id;
      const userState = await getUserState(userId);
      const wallet = userState.wallets.find(w => w.address === data.address);

      if (!wallet) {
        logger.warn(`Wallet not found for address: ${data.address}`);
        return res.status(404).json({ status: 'error', message: 'Wallet not found' });
      }

      if (!SUPPORTED_ASSETS.includes(data.asset)) {
        const errorMsg = userState.usePidgin
          ? `❌ Wahala dey o! You send *${data.asset}* but we only dey accept USDC and USDT. Contact support abeg!`
          : `❌ Oops! You sent *${data.asset}*, but we only accept USDC and USDT. Please contact support!`;
        await bot.telegram.sendPhoto(userId, { source: ERROR_IMAGE }, {
          caption: errorMsg,
          parse_mode: 'Markdown',
        });
        return res.status(200).json({ status: 'success' });
      }

      const amount = parseFloat(data.amount);
      wallet.amount = (wallet.amount || 0) + amount;
      wallet.totalDeposits = (wallet.totalDeposits || 0) + amount;
      await updateUserState(userId, { wallets: userState.wallets });

      const depositMsg = userState.usePidgin
        ? `💰 *Deposit Don Land!*\n\n` +
          `You don deposit *${amount} ${data.asset}* to your wallet (*${data.address.slice(-4)}*). E don enter safe!`
        : `💰 *Deposit Successful!*\n\n` +
          `You’ve deposited *${amount} ${data.asset}* to your wallet (*${data.address.slice(-4)}*). It’s safely received!`
      await bot.telegram.sendPhoto(userId, { source: DEPOSIT_SUCCESS_IMAGE }, {
        caption: depositMsg,
        parse_mode: 'Markdown',
      });

      if (!wallet.bank) {
        const linkBankMsg = userState.usePidgin
          ? `🏦 You never link bank o! Abeg go to "💼 View Wallet" and link your bank to cash out this ${amount} ${data.asset}.`
          : `🏦 You haven’t linked a bank yet! Please go to "💼 View Wallet" to link your bank and cash out this ${amount} ${data.asset}.`;
        await bot.telegram.sendMessage(userId, linkBankMsg, {
          parse_mode: 'Markdown',
          reply_markup: getWalletMenu().reply_markup
        });
        return res.status(200).json({ status: 'success' });
      }

      const referenceId = generateReferenceId();
      const orderData = await createPaycrestOrder(userId, amount, data.asset, wallet.chain, wallet.bank, data.address);

      const txData = {
        userId,
        referenceId,
        status: 'Pending',
        amount,
        asset: data.asset,
        chain: wallet.chain,
        payout: calculatePayoutWithFee(amount, exchangeRates[data.asset]),
        bankDetails: wallet.bank,
        timestamp: new Date().toISOString(),
        transactionHash: data.transactionHash,
        blockradarRate: exchangeRates[data.asset],
      };
      await db.collection('transactions').add(txData);

      const processingMsg = userState.usePidgin
        ? `🔄 *Processing Payout...*\n\nWe dey process your *${amount} ${data.asset}* to *₦${txData.payout}*. E go soon land your bank!`
        : `🔄 *Processing Payout...*\n\nWe’re processing your *${amount} ${data.asset}* into *₦${txData.payout}*. It’ll hit your bank soon!`;
      await bot.telegram.sendMessage(userId, processingMsg, { parse_mode: 'Markdown' });

      await withdrawFromBlockradar(wallet.chain, chains[wallet.chain].assets[data.asset], orderData.depositAddress, amount, referenceId, { userId });
    }
    res.status(200).json({ status: 'success' });
  } catch (error) {
    logger.error(`Error in Blockradar webhook: ${error.message}`);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Server Startup
app.listen(PORT, async () => {
  logger.info(`Server running on port ${PORT}`);
  try {
    await bot.telegram.setWebhook(`${WEBHOOK_DOMAIN}${WEBHOOK_PATH}`);
    logger.info(`Telegram webhook set to ${WEBHOOK_DOMAIN}${WEBHOOK_PATH}`);
  } catch (error) {
    logger.error(`Error setting Telegram webhook: ${error.message}`);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
});

// Bank Linking Scene Actions
bankLinkingScene.action('confirm_bank_yes', async (ctx) => {
  const userId = ctx.from.id.toString();
  const bankData = ctx.session.bankData;
  const walletIndex = ctx.session.walletIndex;

  try {
    let userState = await getUserState(userId);
    const wallet = userState.wallets[walletIndex];

    if (!wallet) {
      const errorMsg = userState.usePidgin
        ? '⚠️ No wallet dey here o! Click "💼 Generate Wallet" for menu to start.'
        : '⚠️ No wallet selected. Please click "💼 Generate Wallet" from the menu to start.';
      await ctx.replyWithMarkdown(errorMsg);
      await ctx.answerCbQuery();
      return ctx.scene.leave();
    }

    wallet.bank = {
      bankName: bankData.bankName,
      bankCode: bankData.bankCode,
      accountNumber: bankData.accountNumber,
      accountName: bankData.accountName,
    };

    await updateUserState(userId, { wallets: userState.wallets });

    const confirmationMessage = userState.usePidgin
      ? `👏 *Bank Account Linked Successfully!*\n\n` +
        `Welcome to DirectPay! Here’s your new wallet setup, fresh like moimoi from Mama’s pot:\n\n` +
        `*Wallet Address:* \`${wallet.address}\`\n` +
        `*Supported Networks:* Base, BNB Smart Chain, Polygon (Matic)\n` +
        `*Supported Assets:* USDC, USDT\n\n` +
        `*Bank Name:* ${bankData.bankName}\n` +
        `*Account Number:* ${bankData.accountNumber}\n` +
        `*Account Holder:* ${bankData.accountName}\n\n` +
        `Only USDC and USDT dey work here o, no try send Shiba Inu unless you wan hear "Wahala dey!" from support. Scan the QR code below to grab your address!`
      : `👏 *Bank Account Linked Successfully!*\n\n` +
        `Welcome to DirectPay! Here are the details of your new wallet setup:\n\n` +
        `*Wallet Address:* \`${wallet.address}\`\n` +
        `*Supported Networks:* Base, BNB Smart Chain, Polygon (Matic)\n` +
        `*Supported Assets:* USDC, USDT\n\n` +
        `*Bank Name:* ${bankData.bankName}\n` +
        `*Account Number:* ${bankData.accountNumber}\n` +
        `*Account Holder:* ${bankData.accountName}\n\n` +
        `Please note, only USDC and USDT are supported across **Base, BNB Smart Chain, and Polygon**. If any other token is deposited, reach out to customer support for assistance. Scan the QR code below to copy your wallet address!`;

    const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(wallet.address)}`;
    const qrCodeResponse = await axios.get(qrCodeUrl, { responseType: 'arraybuffer' });
    const qrCodeBuffer = Buffer.from(qrCodeResponse.data);

    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
      logger.info(`Created temp directory at ${tempDir}`);
    }

    const outputImagePath = path.join(tempDir, `wallet_generated_${userId}.png`);
    await sharp(WALLET_GENERATED_IMAGE)
      .composite([{ input: qrCodeBuffer, top: 550, left: 950 }])
      .toFile(outputImagePath);

    await bot.telegram.sendPhoto(userId, { source: outputImagePath }, {
      caption: confirmationMessage,
      parse_mode: 'Markdown',
    });

    fs.unlinkSync(outputImagePath);

    if (!userState.firstName) {
      const namePrompt = userState.usePidgin
        ? `📋 One small question: This bank account wey you link (${bankData.accountName}), na for you or for another person?\n\n` +
          `[✅ Na me o!] [❌ Na third party]`
        : `📋 One quick question: Is this bank account (${bankData.accountName}) yours or someone else’s?\n\n` +
          `[✅ It’s mine!] [❌ It’s a third party’s]`;
      await ctx.replyWithMarkdown(namePrompt, Markup.inlineKeyboard([
        [Markup.button.callback(userState.usePidgin ? '✅ Na me o!' : '✅ It’s mine!', 'bank_is_mine')],
        [Markup.button.callback(userState.usePidgin ? '❌ Na third party' : '❌ It’s a third party’s', 'bank_is_third_party')],
      ]));
    } else {
      const mainMenu = getWalletMenu();
      const menuText = userState.usePidgin
        ? `Here’s your wallet menu, ${userState.firstName} wey sabi road:`
        : `Here’s your wallet menu, ${userState.firstName}:`;
      await bot.telegram.sendMessage(userId, menuText, {
        reply_markup: mainMenu.reply_markup,
        parse_mode: 'Markdown',
      });
      if (isAdmin(userId)) {
        const adminText = userState.usePidgin
          ? `Admin options, ${userState.firstName} the boss:`
          : `Admin options, ${userState.firstName}:`;
        await bot.telegram.sendMessage(userId, adminText, Markup.inlineKeyboard([
          [Markup.button.callback('🔧 Admin Panel', 'open_admin_panel')]
        ]));
      }
    }

    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🔗 User ${userId} linked a bank account:\n\n` +
      `*Username:* @${ctx.from.username || 'N/A'}\n` +
      `*First Name:* ${userState.firstName || 'Not set yet'}\n` +
      `*Bank Name:* ${wallet.bank.bankName}\n` +
      `*Account Number:* ${wallet.bank.accountNumber}\n` +
      `*Account Holder:* ${wallet.bank.accountName}`, { parse_mode: 'Markdown' });
    logger.info(`User ${userId} linked a bank account: ${JSON.stringify(wallet.bank)}`);

    await ctx.answerCbQuery();
    ctx.scene.leave();
  } catch (error) {
    logger.error(`Error in confirm_bank_yes handler for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ E no work o! Try again later abeg.'
      : '❌ An error occurred while confirming your bank details. Please try again later.';
    await bot.telegram.sendPhoto(userId, { source: ERROR_IMAGE }, {
      caption: errorMsg,
      parse_mode: 'Markdown',
    });
    await ctx.answerCbQuery();
    ctx.scene.leave();
  }
});

bankLinkingScene.action('bank_is_mine', async (ctx) => {
  const userId = ctx.from.id.toString();
  const bankData = ctx.session.bankData;

  try {
    const userState = await getUserState(userId);
    const firstName = bankData.accountName.split(' ')[0];
    await updateUserState(userId, { firstName });

    const confirmMsg = userState.usePidgin
      ? `Ehen! Good choice, ${firstName}! We go dey call you ${firstName} from now on, sharp person wey sabi road. Here’s your wallet menu:`
      : `Great! We’ll call you ${firstName} from now on. Here’s your wallet menu, ${firstName}:`;
    const mainMenu = getWalletMenu();
    await ctx.replyWithMarkdown(confirmMsg, {
      reply_markup: mainMenu.reply_markup,
    });

    if (isAdmin(userId)) {
      const adminText = userState.usePidgin
        ? `Admin options, ${firstName} the boss:`
        : `Admin options, ${firstName}:`;
      await ctx.reply(adminText, Markup.inlineKeyboard([
        [Markup.button.callback('🔧 Admin Panel', 'open_admin_panel')]
      ]));
    }

    await ctx.answerCbQuery();
    ctx.scene.leave();
  } catch (error) {
    logger.error(`Error in bank_is_mine handler for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '⚠️ Something no work o! Try again abeg.'
      : '⚠️ An error occurred. Please try again.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
    ctx.scene.leave();
  }
});

bankLinkingScene.action('bank_is_third_party', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const prompt = userState.usePidgin
    ? 'Okay o! Who you be then? Abeg tell us your first name and last name so we fit know you well-well:\n(Reply with "FirstName LastName", e.g., "Chioma Eze")'
    : 'Alright! What’s your name then? Please provide your first name and last name so we can identify you:\n(Reply with "FirstName LastName", e.g., "Chioma Eze")';
  await ctx.replyWithMarkdown(prompt);
  ctx.session.awaitingName = true;
  await ctx.answerCbQuery();
});

bankLinkingScene.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (ctx.session.awaitingName) {
    try {
      const input = ctx.message.text.trim();
      const userState = await getUserState(userId);
      const nameParts = input.split(' ');
      if (nameParts.length < 2) {
        const errorMsg = userState.usePidgin
          ? '❌ E no complete o! Abeg give us your first name and last name together (e.g., "Chioma Eze").'
          : '❌ That’s not complete! Please provide both your first name and last name (e.g., "Chioma Eze").';
        await ctx.replyWithMarkdown(errorMsg);
        return;
      }

      const firstName = nameParts[0];
      await updateUserState(userId, { firstName });

      const confirmMsg = userState.usePidgin
        ? `Correct! From now on, we go dey call you ${firstName}, fine person wey dey run things! Here’s your wallet menu:`
        : `Perfect! From now on, we’ll call you ${firstName}. Here’s your wallet menu, ${firstName}:`;
      const mainMenu = getWalletMenu();
      await ctx.replyWithMarkdown(confirmMsg, {
        reply_markup: mainMenu.reply_markup,
      });

      if (isAdmin(userId)) {
        const adminText = userState.usePidgin
          ? `Admin options, ${firstName} the boss:`
          : `Admin options, ${firstName}:`;
        await ctx.reply(adminText, Markup.inlineKeyboard([
          [Markup.button.callback('🔧 Admin Panel', 'open_admin_panel')]
        ]));
      }

      delete ctx.session.awaitingName;
      ctx.scene.leave();
    } catch (error) {
      logger.error(`Error in name input handler for user ${userId}: ${error.message}`);
      const userState = await getUserState(userId);
      const errorMsg = userState.usePidgin
        ? '⚠️ Something no work o! Try again abeg.'
        : '⚠️ An error occurred. Please try again.';
      await ctx.replyWithMarkdown(errorMsg);
      delete ctx.session.awaitingName;
      ctx.scene.leave();
    }
  }
});

bankLinkingScene.action('confirm_bank_no', async (ctx) => {
  try {
    const userState = await getUserState(ctx.from.id.toString());
    const msg = userState.usePidgin
      ? '⚠️ Let’s try again o!'
      : '⚠️ Let’s try again.';
    await ctx.replyWithMarkdown(msg);
    await ctx.scene.reenter();
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in confirm_bank_no handler: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again.');
    await ctx.answerCbQuery();
    ctx.scene.leave();
  }
});

bankLinkingScene.action('cancel_bank_linking', async (ctx) => {
  try {
    const userState = await getUserState(ctx.from.id.toString());
    const msg = userState.usePidgin
      ? '❌ Bank linking don cancel o!'
      : '❌ Bank linking process has been canceled.';
    await ctx.replyWithMarkdown(msg);
    delete ctx.session.walletIndex;
    delete ctx.session.bankData;
    delete ctx.session.processType;
    await ctx.answerCbQuery();
    ctx.scene.leave();
  } catch (error) {
    logger.error(`Error in cancel_bank_linking handler: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again.');
    await ctx.answerCbQuery();
    ctx.scene.leave();
  }
});
