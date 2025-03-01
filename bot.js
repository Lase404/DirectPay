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

// Environment Variables (unchanged)
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

// Bank List and Chain Configurations (unchanged)
const bankList = [
  { name: 'Access Bank', code: '044', aliases: ['access', 'access bank', 'accessb', 'access bank nigeria'], paycrestInstitutionCode: 'ABNGNGLA' },
  // ... (rest unchanged)
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
  // ... (rest unchanged)
};

// Utility Functions (updated getUserState)
function mapToPaycrest(asset, chainName) { /* unchanged */ }
function calculatePayoutWithFee(amount, rate, feePercent = 0.5) { /* unchanged */ }
function generateReferenceId() { /* unchanged */ }
async function verifyBankAccount(accountNumber, bankCode) { /* unchanged */ }
async function createPaycrestOrder(userId, amount, token, network, recipientDetails, userSendAddress) { /* unchanged */ }
async function withdrawFromBlockradar(chain, assetId, address, amount, reference, metadata) { /* unchanged */ }

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
    // Return a fallback state to prevent downstream errors
    const fallbackState = {
      firstName: '',
      wallets: [],
      walletAddresses: [],
      hasReceivedDeposit: false,
      awaitingBroadcastMessage: false,
      usePidgin: false,
    };
    return fallbackState;
  }
}

async function updateUserState(userId, newState) { /* unchanged */ }
async function generateWallet(chain) { /* unchanged */ }

// Bank Linking Scene (unchanged from previous update)
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
        logger.info(`Bank name prompt sent to user ${userId}`);
      } catch (sendError) {
        logger.error(`Failed to send bank name prompt to user ${userId}: ${sendError.message}`);
        throw sendError;
      }

      return ctx.wizard.next().then(() => {
        logger.info(`Advanced to step 2 for user ${userId}`);
      });
    } catch (error) {
      logger.error(`Error in bank_linking_scene step 1 for user ${userId}: ${error.message}`);
      await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again.');
      return ctx.scene.leave();
    }
  },
  // ... (other steps unchanged)
);

// Scene Setup with Persistent Session (unchanged)
const stage = new Scenes.Stage();
stage.register(bankLinkingScene);

bot.use(session({
  store: {
    get: async (key) => {
      const doc = await db.collection('sessions').doc(key).get();
      return doc.exists ? doc.data() : undefined;
    },
    set: async (key, sess) => {
      await db.collection('sessions').doc(key).set(sess);
    },
    delete: async (key) => {
      await db.collection('sessions').doc(key).delete();
    },
  },
}));
bot.use(stage.middleware());

// Exchange Rates (unchanged)
const SUPPORTED_ASSETS = ['USDC', 'USDT'];
let exchangeRates = { USDC: 0, USDT: 0 };

async function fetchExchangeRate(asset) { /* unchanged */ }
async function fetchExchangeRates() { /* unchanged */ }
fetchExchangeRates();
setInterval(fetchExchangeRates, 300000);

// Menu Functions (unchanged)
const getMainMenu = () => Markup.keyboard([/* unchanged */]).resize();
const getWalletMenu = () => Markup.keyboard([/* unchanged */]).resize();
const isAdmin = (userId) => ADMIN_IDS.split(',').map(id => id.trim()).includes(userId.toString());

// Bot Handlers
bot.start(async (ctx) => { /* unchanged */ });
async function greetUser(ctx) { /* unchanged */ }
bot.hears(/^[Pp][Ii][Dd][Gg][Ii][Nn]$/, async (ctx) => { /* unchanged */ });

bot.hears('💼 Generate Wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    logger.info(`User ${userId} requested wallet generation`);
    const userState = await getUserState(userId);
    
    if (!userState || typeof userState.wallets === 'undefined') {
      logger.error(`Invalid user state for ${userId}: ${JSON.stringify(userState)}`);
      throw new Error('User state is invalid or missing wallets');
    }

    if (userState.wallets.length >= MAX_WALLETS) {
      const errorMsg = userState.usePidgin
        ? `⚠️ You don reach max wallets o (${MAX_WALLETS})! Manage the ones you get first abeg.`
        : `⚠️ You have reached the maximum number of wallets (${MAX_WALLETS}). Please manage your existing wallets before adding new ones.`;
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }
    
    const pendingMsg = userState.usePidgin
      ? '🔄 *Generating Wallet...* Hold small, we dey cook am hot-hot!'
      : '🔄 *Generating Wallet...* Hold on, we’re preparing it fast!';
    const pendingMessage = await ctx.replyWithMarkdown(pendingMsg);

    logger.info(`Generating wallet for user ${userId} on chain Base`);
    const chain = 'Base';
    const walletAddress = await generateWallet(chain);

    userState.wallets.push({
      address: walletAddress,
      chain: chain,
      name: `Wallet ${userState.wallets.length + 1}`,
      supportedAssets: ['USDC', 'USDT'],
      bank: null,
      amount: 0,
      creationDate: new Date().toISOString(),
      totalDeposits: 0,
      totalPayouts: 0
    });
    userState.walletAddresses.push(walletAddress);

    logger.info(`Updating user state with new wallet for user ${userId}`);
    await updateUserState(userId, {
      wallets: userState.wallets,
      walletAddresses: userState.walletAddresses,
    });

    await ctx.deleteMessage(pendingMessage.message_id);
    const successMsg = userState.usePidgin
      ? `✅ *Wallet Generated Successfully!*\n\n` +
        `*Supported Networks:* Base, BNB Smart Chain, Polygon (Matic)\n` +
        `*Supported Assets:* USDC, USDT\n\n` +
        `Abeg link your bank account quick-quick to use this wallet!`
      : `✅ *Wallet Generated Successfully!*\n\n` +
        `*Supported Networks:* Base, BNB Smart Chain, Polygon (Matic)\n` +
        `*Supported Assets:* USDC, USDT\n\n` +
        `Please link a bank account to proceed with using this wallet!`;
    await ctx.replyWithMarkdown(successMsg);

    logger.info(`Setting walletIndex to ${userState.wallets.length - 1} for user ${userId}`);
    ctx.session.walletIndex = userState.wallets.length - 1;
    logger.info(`Entering bank_linking_scene for user ${userId}, session: ${JSON.stringify(ctx.session)}`);
    await ctx.scene.enter('bank_linking_scene');
    logger.info(`Successfully entered bank_linking_scene for user ${userId}`);
  } catch (error) {
    logger.error(`Error generating wallet for user ${userId}: ${error.message}`);
    const fallbackMsg = '⚠️ An error occurred while generating your wallet. Please try again later.';
    await ctx.replyWithMarkdown(fallbackMsg);
  }
});

// Admin Panel Handler (unchanged)
bot.action(/admin_(.+)/, async (ctx) => { /* unchanged */ });

// Text Handler with Fixes
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

// Webhook Handlers (unchanged)
app.use(bodyParser.json());
app.use(requestIp.mw());

app.post(WEBHOOK_PATH, (req, res) => {
  bot.handleUpdate(req.body);
  res.sendStatus(200);
});

app.post(WEBHOOK_PAYCREST_PATH, async (req, res) => { /* unchanged */ });
app.post(WEBHOOK_BLOCKRADAR_PATH, async (req, res) => { /* unchanged */ });

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
