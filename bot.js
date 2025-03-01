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

// Utility Functions (unchanged except getUserState)
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

async function updateUserState(userId, newState) { /* unchanged */ }
async function generateWallet(chain) { /* unchanged */ }

// Updated Bank Linking Scene
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

      logger.info(`Advancing to step 2 for user ${userId}`);
      return ctx.wizard.next(); // Fixed: Removed .then()
    } catch (error) {
      logger.error(`Error in bank_linking_scene step 1 for user ${userId}: ${error.message}`);
      await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again.');
      return ctx.scene.leave();
    }
  },
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const input = ctx.message.text.trim();
    logger.info(`User ${userId} entered bank name: ${input}`);

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
    logger.info(`User ${userId} entered account number: ${input}`);

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

// Bank Linking Scene Actions (unchanged)
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

    const qrCodePosition = { top: 550, left: 950 };
    const outputImagePath = path.join(__dirname, `temp/wallet_generated_${userId}.png`);
    await sharp(WALLET_GENERATED_IMAGE)
      .composite([{ input: qrCodeBuffer, top: qrCodePosition.top, left: qrCodePosition.left }])
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

// Remaining bankLinkingScene actions (unchanged)...

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

// Bot Handlers (unchanged except wallet generation)
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

// Text Handler (unchanged)
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
