// =================== Import Dependencies ===================
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

// =================== Environment Variables ===================
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

// =================== Validations ===================
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

// Image Paths
const WALLET_GENERATED_IMAGE = './images/wallet_generated_base.png';
const DEPOSIT_SUCCESS_IMAGE = './images/deposit_success.png';
const PAYOUT_SUCCESS_IMAGE = './images/payout_success.png';
const ERROR_IMAGE = './images/error.png';

// =================== Initialize Express App ===================
const app = express();

// =================== Initialize Telegraf Bot ===================
const bot = new Telegraf(BOT_TOKEN);

// =================== Define Supported Banks ===================
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

// =================== Define Supported Chains ===================
const chains = {
  Base: {
    id: 'e31c44d6-0344-4ee1-bcd1-c88e89a9e3f1',
    key: BLOCKRADAR_BASE_API_KEY,
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
    key: BLOCKRADAR_POLYGON_API_KEY,
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
    key: BLOCKRADAR_BNB_API_KEY,
    apiUrl: 'https://api.blockradar.co/v1/wallets/7a844e91-5740-4589-9695-c74411adec7e/addresses',
    supportedAssets: ['USDT', 'USDC'],
    network: 'BNB Smart Chain',
    assets: {
      USDC: 'ff479231-0dbb-4760-b695-e219a50934af',
      USDT: '03a11a51-1422-4ac0-abc0-b2fed75e9fcb',
    }
  }
};

// =================== Chain Mapping ===================
const chainMapping = {
  'base': 'Base',
  'polygon': 'Polygon',
  'bnb smart chain': 'BNB Smart Chain',
  'bnb smartchain': 'BNB Smart Chain',
  'bnb chain': 'BNB Smart Chain',
  'bnb': 'BNB Smart Chain',
};

// =================== Helper Functions ===================

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
      await db.collection('users').doc(userId).set({
        firstName: '',
        wallets: [],
        walletAddresses: [],
        hasReceivedDeposit: false,
        awaitingBroadcastMessage: false,
        usePidgin: false,
      });
      return {
        firstName: '',
        wallets: [],
        walletAddresses: [],
        hasReceivedDeposit: false,
        awaitingBroadcastMessage: false,
        usePidgin: false,
      };
    } else {
      const data = userDoc.data();
      return {
        firstName: data.firstName || '',
        wallets: data.wallets || [],
        walletAddresses: data.walletAddresses || [],
        hasReceivedDeposit: data.hasReceivedDeposit || false,
        awaitingBroadcastMessage: data.awaitingBroadcastMessage || false,
        usePidgin: data.usePidgin || false,
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

// =================== Define Scenes ===================

const bankLinkingScene = new Scenes.WizardScene(
  'bank_linking_scene',
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const walletIndex = ctx.session.walletIndex;

    if (walletIndex === undefined || walletIndex === null) {
      const userState = await getUserState(userId);
      const errorMsg = userState.usePidgin
        ? '⚠️ No wallet dey here o! Click "💼 Generate Wallet" for menu to start.'
        : '⚠️ No wallet selected. Please click "💼 Generate Wallet" from the menu to start.';
      await ctx.replyWithMarkdown(errorMsg);
      return ctx.scene.leave();
    }

    ctx.session.bankData = {};
    ctx.session.bankData.step = 1;
    const userState = await getUserState(userId);
    const prompt = userState.usePidgin
      ? '🏦 Abeg enter your bank name (e.g., Access Bank), my friend:'
      : '🏦 Please enter your bank name (e.g., Access Bank):';
    await ctx.replyWithMarkdown(prompt);
    return ctx.wizard.next();
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
      logger.error(`Error in bank linking step 2 for user ${userId}: ${error.message}`);
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
        throw new Error('Invalid verification response.');
      }

      const accountName = verificationResult.data.account_name;
      if (!accountName) throw new Error('Unable to retrieve account name.');

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
    return; // Confirmation handled by actions
  }
);

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

// =================== Register Scenes with Stage ===================
const stage = new Scenes.Stage();
stage.register(bankLinkingScene);

// =================== Apply Middlewares ===================
bot.use(session());
bot.use(stage.middleware());

// =================== Exchange Rate Fetching ===================
const SUPPORTED_ASSETS = ['USDC', 'USDT'];
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

// =================== Main Menu ===================
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

// =================== Check if User is Admin ===================
const isAdmin = (userId) => ADMIN_IDS.split(',').map(id => id.trim()).includes(userId.toString());

// =================== /start Command ===================
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

    const location = ctx.session?.location || 'Unknown';
    if (location === 'Nigeria' && !userState.usePidgin) {
      await ctx.reply('By the way, we notice you might be in Nigeria. Want to switch to Pidgin for a more local vibe? Just say "Pidgin" anytime!');
    }

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

// Handle Pidgin switch
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
      ctx.session.walletIndex = userState.wallets.length - 1; // Use the latest wallet
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

// =================== Generate Wallet Handler ===================
bot.hears('💼 Generate Wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    
    if (userState.wallets.length >= MAX_WALLETS) {
      const errorMsg = userState.usePidgin
        ? `⚠️ You don reach max wallets o (${MAX_WALLETS})! Manage the ones you get first abeg.`
        : `⚠️ You have reached the maximum number of wallets (${MAX_WALLETS}). Please manage your existing wallets before adding new ones.`;
      return ctx.replyWithMarkdown(errorMsg);
    }
    
    const pendingMsg = userState.usePidgin
      ? '🔄 *Generating Wallet...* Hold small, we dey cook am hot-hot!'
      : '🔄 *Generating Wallet...* Hold on, we’re preparing it fast!';
    const pendingMessage = await ctx.replyWithMarkdown(pendingMsg);

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

    ctx.session.walletIndex = userState.wallets.length - 1;
    await ctx.scene.enter('bank_linking_scene');
  } catch (error) {
    logger.error(`Error generating wallet for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '⚠️ E no work o! Try again later abeg.'
      : '⚠️ An error occurred while generating your wallet. Please try again later.';
    await ctx.replyWithMarkdown(errorMsg);
  }
});

// =================== View Wallet Handler ===================
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

// Wallet Actions
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
      : `🌟 *${wallet.name || `Wallet #${walletIndex + 1}}*\n\n` +
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
  if (ctx.session.awaitingRename !== undefined) {
    try {
      const userState = await getUserState(userId);
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
    await ctx.scene.enter('bank_linking_scene');
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
    userState.walletAddresses = userState.walletAddresses.filter(addr => addr !== wallet.address);
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

// =================== Settings Handler ===================
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
      ? userState.firstName
        ? `Welcome back to the menu, ${userState.firstName} wey sabi!`
        : 'Welcome back to the menu, my friend!'
      : userState.firstName
        ? `Welcome back to the menu, ${userState.firstName}!`
        : 'Welcome back to the menu!';
    await ctx.replyWithMarkdown(menuText, {
      reply_markup: mainMenu.reply_markup,
    });

    if (isAdmin(userId)) {
      const adminText = userState.usePidgin
        ? userState.firstName
          ? `Admin options, ${userState.firstName} the boss:`
          : 'Admin options, big boss:'
        : userState.firstName
          ? `Admin options, ${userState.firstName}:`
          : 'Admin options, esteemed user:';
      await ctx.reply(adminText, Markup.inlineKeyboard([
        [Markup.button.callback('🔧 Admin Panel', 'open_admin_panel')]
      ]));
    }
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in settings_back_main for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again.');
    await ctx.answerCbQuery();
  }
});

// =================== Support Handler ===================
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

// =================== Learn About Base Handler ===================
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

// =================== Transactions Handler ===================
async function transactionsHandler(ctx) {
  const userId = ctx.from.id.toString();
  const pageSize = 5;
  let page = ctx.session.transactionsPage || 1;
  let filter = ctx.session.transactionsFilter || 'all';
  let asset = ctx.session.transactionsAsset || 'All';
  const filterOptions = ['All', 'Pending', 'Failed', 'Completed']; // Reordered for character length
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

// =================== View Current Rates Handler ===================
bot.hears('📈 View Current Rates', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    const now = new Date().toLocaleTimeString('en-US', { timeZone: 'Africa/Lagos', hour12: false });
    const date = new Date().toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' });
    const userName = userState.firstName || 'sharp person';

    let ratesMessage = userState.usePidgin
      ? `📈 *Current Exchange Rates (${now} WAT, ${date})*\n\n`
      : `📈 *Current Exchange Rates (${now} WAT, ${date})*\n\n`;

    for (const asset of SUPPORTED_ASSETS) {
      const paycrestRate = exchangeRates[asset] || 0;
      const funnyComment = userState.usePidgin
        ? `*Ehen, ${userName}! DirectPay dey give you ₦${paycrestRate.toFixed(2)} per ${asset}. Na we dey run things o!*`
        : `*Great news, ${userName}! DirectPay offers ₦${paycrestRate.toFixed(2)} per ${asset}. We’re the top choice!*`;

      ratesMessage += `• *${asset}*\n` +
        `  - Paycrest Rate: ₦${paycrestRate.toFixed(2)}\n` +
        `  - ${funnyComment}\n\n`;
    }

    ratesMessage += userState.usePidgin
      ? `No dulling o, ${userName}! DirectPay rates dey hot!`
      : `Stay smart, ${userName}! DirectPay’s rates are unbeatable!`;
    await ctx.replyWithMarkdown(ratesMessage, getMainMenu());
  } catch (error) {
    logger.error(`Error in View Current Rates for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '⚠️ E no work o! Try again later abeg.'
      : '⚠️ An error occurred while fetching rates. Please try again later.';
    await ctx.replyWithMarkdown(errorMsg);
  }
});

// =================== Admin Panel ===================
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

// Admin Actions (Placeholders)
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
        message = userState.usePidgin
          ? '📋 *View Recent Transactions*\n\nThis go show recent transactions o. Still under construction!'
          : '📋 *View Recent Transactions*\n\nThis will display recent transactions. Under development!';
        break;
      case 'send_message':
        message = userState.usePidgin
          ? '📨 *Send Message to User*\n\nThis go let you send message to any user o. Coming soon!'
          : '📨 *Send Message to User*\n\nThis will allow sending messages to any user. Coming soon!';
        break;
      case 'mark_paid':
        message = userState.usePidgin
          ? '✅ *Mark Transactions as Paid*\n\nThis go mark pending transactions as paid o. Under construction!'
          : '✅ *Mark Transactions as Paid*\n\nThis will mark pending transactions as paid. Under development!';
        break;
      case 'view_users':
        message = userState.usePidgin
          ? '👥 *View All Users*\n\nThis go show all users wey dey use DirectPay o. Still building!'
          : '👥 *View All Users*\n\nThis will display all DirectPay users. Still in progress!';
        break;
      case 'broadcast_message':
        message = userState.usePidgin
          ? '📢 *Broadcast Message*\n\nThis go send message to everybody o. Work in progress!'
          : '📢 *Broadcast Message*\n\nThis will send a message to all users. Work in progress!';
        break;
      case 'back_to_main':
        await greetUser(ctx);
        if (ctx.session.adminMessageId) {
          await ctx.deleteMessage(ctx.session.adminMessageId).catch(() => {});
          ctx.session.adminMessageId = null;
        }
        await ctx.answerCbQuery();
        return;
      default:
        message = userState.usePidgin
          ? '⚠️ Wetin be this o? Pick correct option abeg.'
          : '⚠️ Unknown action. Please select an option from the menu.';
    }

    await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: getAdminMenu().reply_markup });
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in admin action handler for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred in the admin panel. Please try again.');
    await ctx.answerCbQuery();
  }
});

/**
 * Generates the Admin Menu Inline Keyboard.
 */
const getAdminMenu = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('📋 View Recent Transactions', 'admin_view_transactions')],
    [Markup.button.callback('📨 Send Message to User', 'admin_send_message')],
    [Markup.button.callback('✅ Mark Transactions as Paid', 'admin_mark_paid')],
    [Markup.button.callback('👥 View All Users', 'admin_view_users')],
    [Markup.button.callback('📢 Broadcast Message', 'admin_broadcast_message')],
    [Markup.button.callback('🔙 Back to Main Menu', 'admin_back_to_main')],
  ]);

// =================== Webhook Handlers ===================

/**
 * =================== Paycrest Webhook Handler ===================
 */
app.post(WEBHOOK_PAYCREST_PATH, bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-paycrest-signature'];
  const rawBody = req.body;

  try {
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

    logger.info(`Received Paycrest event: ${event}`);

    const orderId = data.id;
    const status = data.status;
    const amountPaid = parseFloat(data.amountPaid) || 0;
    const reference = data.reference;
    const returnAddress = data.returnAddress;

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
    const userState = await getUserState(userId);
    const userFirstName = userState.firstName || 'valued user';

    switch (event) {
      case 'payment_order.pending':
        const pendingMsg = userState.usePidgin
          ? 'We dey process your order now o. Abeg wait small for update!'
          : 'We are currently processing your order. Please wait for further updates.';
        await bot.telegram.sendMessage(userId, pendingMsg, { parse_mode: 'Markdown' });
        await bot.telegram.sendMessage(
          PERSONAL_CHAT_ID,
          `🔄 *Payment Order Pending*\n\n*User:* ${userFirstName} (ID: ${userId})\n*Reference ID:* ${reference}\n*Amount Paid:* ₦${amountPaid}`,
          { parse_mode: 'Markdown' }
        );
        break;

      case 'payment_order.settled':
        const payoutMessage = userState.usePidgin
          ? `🎉 *Funds Credited Successfully!*\n\n` +
            `Hello ${txData.bankDetails.accountName},\n\n` +
            `Your DirectPay order don complete o! Here’s the full gist:\n\n` +
            `*Crypto amount:* ${txData.amount} ${txData.asset}\n` +
            `*Cash amount:* NGN ${txData.payout}\n` +
            `*Network:* ${txData.chain}\n` +
            `*Date:* ${new Date(txData.timestamp).toLocaleString()}\n\n` +
            `Thank you 💙.\n\n` +
            `${userFirstName}, you don hammer o! NGN ${txData.payout} just land like hot amala for your plate. Na you sabi road!`
          : `🎉 *Funds Credited Successfully!*\n\n` +
            `Hello ${txData.bankDetails.accountName},\n\n` +
            `Your DirectPay order has been completed. Here are the details:\n\n` +
            `*Crypto amount:* ${txData.amount} ${txData.asset}\n` +
            `*Cash amount:* NGN ${txData.payout}\n` +
            `*Network:* ${txData.chain}\n` +
            `*Date:* ${new Date(txData.timestamp).toLocaleString()}\n\n` +
            `Thank you 💙.\n\n` +
            `${userFirstName}, you’ve struck gold! NGN ${txData.payout} just landed like a VIP delivery—smart move!`;

        await bot.telegram.sendPhoto(userId, { source: PAYOUT_SUCCESS_IMAGE }, {
          caption: payoutMessage,
          parse_mode: 'Markdown',
        });

        await db.collection('transactions').doc(txDoc.id).update({ status: 'Completed' });

        await bot.telegram.sendMessage(
          PERSONAL_CHAT_ID,
          `✅ *Payment Order Settled*\n\n*User:* ${userFirstName} (ID: ${userId})\n*Reference ID:* ${reference}\n*Amount Paid:* ₦${amountPaid}`,
          { parse_mode: 'Markdown' }
        );

        if (!userState.hasReceivedDeposit) {
          const feedbackMsg = userState.usePidgin
            ? `📝 *Feedback*\n\nHow you see DirectPay so far, ${userFirstName}?\n\n[👍 Great o!] [👎 No good] [🤔 Suggestions]`
            : `📝 *Feedback*\n\nHow was your experience with DirectPay, ${userFirstName}?\n\n[👍 Great!] [👎 Not Good] [🤔 Suggestions]`;
          await bot.telegram.sendMessage(
            userId,
            feedbackMsg,
            Markup.inlineKeyboard([
              [Markup.button.callback(userState.usePidgin ? '👍 Great o!' : '👍 Great!', 'feedback_great')],
              [Markup.button.callback(userState.usePidgin ? '👎 No good' : '👎 Not Good', 'feedback_not_good')],
              [Markup.button.callback('🤔 Suggestions', 'feedback_suggestions')]
            ])
          );
          await updateUserState(userId, { hasReceivedDeposit: true });
        }
        break;

      case 'payment_order.expired':
      case 'payment_order.refunded':
        const statusMsg = event === 'payment_order.expired' ? 'expired' : 'refunded';
        const userMsg = userState.usePidgin
          ? `⚠️ *Your DirectPay order don ${statusMsg} o!*\n\n` +
            `Hello ${userFirstName},\n\n` +
            `We sorry say your DirectPay order with *Reference ID:* \`${reference}\` don ${statusMsg}. Reason be say we get small wahala processing am. No worry, we don return the funds to your wallet.\n\n` +
            `If you feel say na mistake or you need help, ping our support team sharp-sharp!\n\n` +
            `Thank you for understanding o.`
          : `⚠️ *Your DirectPay order has ${statusMsg}.*\n\n` +
            `Hello ${userFirstName},\n\n` +
            `We regret to inform you that your DirectPay order with *Reference ID:* \`${reference}\` has ${statusMsg}.\n\n` +
            `*Reason:* We experienced issues while processing your order. Rest assured, the funds have been returned to your original payment method.\n\n` +
            `If you believe this is a mistake or need further assistance, please contact our support team.\n\n` +
            `Thank you for your understanding.`;
        await bot.telegram.sendMessage(userId, userMsg, { parse_mode: 'Markdown' });

        await db.collection('transactions').doc(txDoc.id).update({ status: statusMsg.charAt(0).toUpperCase() + statusMsg.slice(1) });

        await bot.telegram.sendMessage(
          PERSONAL_CHAT_ID,
          `${event === 'payment_order.expired' ? '⏰' : '🔄'} *Payment Order ${statusMsg.charAt(0).toUpperCase() + statusMsg.slice(1)}*\n\n` +
          `*User:* ${userFirstName} (ID: ${userId})\n*Reference ID:* ${reference}\n*Amount Paid:* ₦${amountPaid}`,
          { parse_mode: 'Markdown' }
        );
        break;

      default:
        logger.info(`Unhandled Paycrest event type: ${event}`);
    }

    res.status(200).send('OK');
  } catch (error) {
    logger.error(`Error in Paycrest webhook handler: ${error.message}`);
    await bot.telegram.sendMessage(
      PERSONAL_CHAT_ID,
      `❗️ Error processing Paycrest webhook: ${error.message}`,
      { parse_mode: 'Markdown' }
    );
    res.status(500).send('Error');
  }
});

/**
 * Verifies Paycrest webhook signature.
 */
function verifyPaycrestSignature(requestBody, signatureHeader, secretKey) {
  const hmac = crypto.createHmac('sha256', secretKey);
  hmac.update(requestBody);
  const calculatedSignature = hmac.digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(calculatedSignature), Buffer.from(signatureHeader));
  } catch (error) {
    return false;
  }
}

/**
 * =================== Blockradar Webhook Handler ===================
 */
app.post(WEBHOOK_BLOCKRADAR_PATH, bodyParser.json(), async (req, res) => {
  try {
    const event = req.body;
    if (!event) {
      logger.error('No event data found in Blockradar webhook.');
      return res.status(400).send('No event data found.');
    }

    logger.info(`Received Blockradar webhook: ${JSON.stringify(event)}`);
    fs.appendFileSync(path.join(__dirname, 'webhook_logs.txt'), `${new Date().toISOString()} - ${JSON.stringify(event, null, 2)}\n`);

    const eventType = event.event || 'Unknown Event';
    const walletAddress = event.data?.recipientAddress || 'N/A';
    const amount = parseFloat(event.data?.amount) || 0;
    const asset = event.data?.asset?.symbol || 'N/A';
    const transactionHash = event.data?.hash || 'N/A';
    const chainRaw = event.data?.blockchain?.name || 'N/A';
    const senderAddress = event.data?.senderAddress || 'N/A';
    const blockradarRate = event.data?.rate || 0; // Rate at transaction time

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

      const existingTxSnapshot = await db.collection('transactions').where('transactionHash', '==', transactionHash).get();
      if (!existingTxSnapshot.empty) {
        logger.info(`Transaction with hash ${transactionHash} already exists. Skipping.`);
        return res.status(200).send('OK');
      }

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
        const noBankMsg = userState.usePidgin
          ? `💰 *Deposit Received:* ${amount} ${asset} on ${chainRaw}. Abeg link bank account make we fit payout o!`
          : `💰 *Deposit Received:* ${amount} ${asset} on ${chainRaw}. Please link a bank account to proceed with payout.`;
        await bot.telegram.sendMessage(userId, noBankMsg, { parse_mode: 'Markdown' });
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ User ${userId} has received a deposit but hasn’t linked a bank account.`, { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      }

      if (!['USDC', 'USDT'].includes(asset)) {
        const unsupportedMsg = userState.usePidgin
          ? `⚠️ *Unsupported Asset Deposited:* ${amount} ${asset} on ${chainRaw}. Na only USDC and USDT we dey take o!`
          : `⚠️ *Unsupported Asset Deposited:* ${amount} ${asset} on ${chainRaw}. Currently, only USDC and USDT are supported.`;
        await bot.telegram.sendMessage(userId, unsupportedMsg, { parse_mode: 'Markdown' });
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ User ${userId} deposited unsupported asset: ${asset}.`, { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      }

      const paycrestRate = exchangeRates[asset] || 0;
      const serviceFeePercent = 0.5;
      const ngnAmount = calculatePayoutWithFee(amount, paycrestRate, serviceFeePercent);

      const referenceId = generateReferenceId();
      const { bankName, accountNumber, accountName } = wallet.bank;
      const userFirstName = userState.firstName || 'valued user';

      const transactionRef = await db.collection('transactions').add({
        userId,
        walletAddress,
        chain: chainRaw,
        amount,
        asset,
        transactionHash,
        referenceId,
        bankDetails: { bankName, accountNumber, accountName },
        payout: ngnAmount,
        blockradarRate, // Store rate at transaction time
        timestamp: new Date().toISOString(),
        status: 'Pending',
        paycrestOrderId: '',
        messageId: null,
        firstName: userFirstName
      });

      const depositMessage = userState.usePidgin
        ? `🎉 *Deposit Received!* ⏳\n\n` +
          `*Amount:* ${amount} ${asset} on ${chainRaw}\n` +
          `*Reference ID:* \`${referenceId}\`\n` +
          `*Exchange Rate:* ₦${blockradarRate} per ${asset} (Blockradar)\n` +
          `*Estimated Payout:* ₦${ngnAmount.toFixed(2)}\n` +
          `*Time:* ${new Date().toLocaleString()}\n` +
          `*Bank Details:*\n` +
          `  - *Account Name:* ${accountName}\n` +
          `  - *Bank:* ${bankName}\n` +
          `  - *Account Number:* ****${accountNumber.slice(-4)}\n\n` +
          `Your money don land, ${userFirstName}! We dey process am now—chill small, e go soon enter your account like VIP package!`
        : `🎉 *Deposit Received!* ⏳\n\n` +
          `*Amount:* ${amount} ${asset} on ${chainRaw}\n` +
          `*Reference ID:* \`${referenceId}\`\n` +
          `*Exchange Rate:* ₦${blockradarRate} per ${asset} (Blockradar)\n` +
          `*Estimated Payout:* ₦${ngnAmount.toFixed(2)}\n` +
          `*Time:* ${new Date().toLocaleString()}\n` +
          `*Bank Details:*\n` +
          `  - *Account Name:* ${accountName}\n` +
          `  - *Bank:* ${bankName}\n` +
          `  - *Account Number:* ****${accountNumber.slice(-4)}\n\n` +
          `Your funds have arrived, ${userFirstName}! We’re processing it now—please wait a moment, it’ll soon hit your account like a VIP delivery!`;

      const sentMessage = await bot.telegram.sendPhoto(userId, { source: DEPOSIT_SUCCESS_IMAGE }, {
        caption: depositMessage,
        parse_mode: 'Markdown'
      });

      await transactionRef.update({ messageId: sentMessage.message_id });

      wallet.totalDeposits = (wallet.totalDeposits || 0) + amount;
      wallet.totalPayouts = (wallet.totalPayouts || 0) + ngnAmount;
      await updateUserState(userId, { wallets: userState.wallets });

      await bot.telegram.sendMessage(
        PERSONAL_CHAT_ID,
        `⚡️ *New Deposit Received*\n\n` +
        `*User ID:* ${userId}\n` +
        `*Username:* @${ctx.from?.username || 'N/A'}\n` +
        `*First Name:* ${userFirstName}\n` +
        `*Amount:* ${amount} ${asset} on ${chainRaw}\n` +
        `*Exchange Rate:* ₦${blockradarRate} per ${asset} (Blockradar)\n` +
        `*Amount to be Paid:* ₦${ngnAmount.toFixed(2)}\n` +
        `*Time:* ${new Date().toLocaleString()}\n` +
        `*Bank Details:*\n` +
        `  - *Account Name:* ${accountName}\n` +
        `  - *Bank:* ${bankName}\n` +
        `  - *Account Number:* ${accountNumber}\n` +
        `*Transaction Hash:* \`${transactionHash}\`\n` +
        `*Reference ID:* ${referenceId}\n`,
        { parse_mode: 'Markdown' }
      );

      res.status(200).send('OK');
    } else if (eventType === 'deposit.swept.success') {
      const txSnapshot = await db.collection('transactions').where('transactionHash', '==', transactionHash).limit(1).get();
      if (txSnapshot.empty) {
        logger.error(`No transaction found for hash: ${transactionHash}`);
        return res.status(200).send('OK');
      }

      const txDoc = txSnapshot.docs[0];
      const txData = txDoc.data();
      const userState = await getUserState(txData.userId);

      if (txData.status === 'Completed' || txData.status === 'Processing' || txData.status === 'Failed') {
        logger.info(`Transaction with hash ${transactionHash} has already been processed. Status: ${txData.status}`);
        return res.status(200).send('OK');
      }

      const paycrestMapping = mapToPaycrest(asset, chainRaw);
      if (!paycrestMapping) {
        logger.error('No Paycrest mapping for this asset/chain.');
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ No Paycrest mapping found for asset ${asset} on chain ${chainRaw}.`);
        return res.status(200).send('OK');
      }

      let paycrestOrder;
      try {
        paycrestOrder = await createPaycrestOrder(txData.userId, amount, asset, chainRaw, txData.bankDetails, senderAddress);
        await txDoc.ref.update({ paycrestOrderId: paycrestOrder.id });
      } catch (err) {
        logger.error(`Error creating Paycrest order: ${err.message}`);
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error creating Paycrest order for user ${txData.userId}: ${err.message}`, { parse_mode: 'Markdown' });
        await txDoc.ref.update({ status: 'Failed' });

        const assuranceMessage = userState.usePidgin
          ? `⚠️ *Withdrawal Wahala Dey!*\n\n` +
            `We get small issue processing your withdrawal o. No worry, we dey work on refund wey go show for your wallet in 3-5 minutes. Sorry for the wahala, abeg bear with us!\n\n` +
            `If you get question, ping our support team sharp-sharp.`
          : `⚠️ *Withdrawal Issue Detected*\n\n` +
            `We’ve encountered an issue processing your withdrawal. Rest assured, we are working on a refund which should reflect in your wallet within 3-5 minutes. We apologize for the inconvenience and appreciate your patience.\n\n` +
            `If you have any questions, please contact our support team.`;
        await bot.telegram.sendPhoto(txData.userId, { source: ERROR_IMAGE }, {
          caption: assuranceMessage,
          parse_mode: 'Markdown'
        });

        return res.status(500).send('Paycrest order error');
      }

      const receiveAddress = paycrestOrder.receiveAddress;
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
        await withdrawFromBlockradar(chainRaw, blockradarAssetId, receiveAddress, amount, paycrestOrder.id, { userId: txData.userId, originalTxHash: transactionHash });
      } catch (err) {
        logger.error(`Error withdrawing from Blockradar: ${err.message}`);
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error withdrawing from Blockradar for user ${txData.userId}: ${err.message}`, { parse_mode: 'Markdown' });
        await txDoc.ref.update({ status: 'Failed' });

        const assuranceMessage = userState.usePidgin
          ? `⚠️ *Withdrawal Wahala Dey!*\n\n` +
            `We get small issue processing your withdrawal o. No worry, we dey work on refund wey go show for your wallet in 3-5 minutes. Sorry for the wahala, abeg bear with us!\n\n` +
            `If you get question, ping our support team sharp-sharp.`
          : `⚠️ *Withdrawal Issue Detected*\n\n` +
            `We’ve encountered an issue processing your withdrawal. Rest assured, we are working on a refund which should reflect in your wallet within 3-5 minutes. We apologize for the inconvenience and appreciate your patience.\n\n` +
            `If you have any questions, please contact our support team.`;
        await bot.telegram.sendPhoto(txData.userId, { source: ERROR_IMAGE }, {
          caption: assuranceMessage,
          parse_mode: 'Markdown'
        });

        return res.status(500).send('Blockradar withdrawal error');
      }

      await txDoc.ref.update({ status: 'Processing' });

      const depositSweptMessage = userState.usePidgin
        ? `🎉 *Deposit Confirmed!* 🔄\n\n` +
          `*Amount:* ${amount} ${asset} on ${chainRaw}\n` +
          `*Reference ID:* \`${txData.referenceId}\`\n` +
          `*Transaction Hash:* \`${transactionHash}\`\n` +
          `Your deposit don set, ${userState.firstName || 'my friend'}! We dey fry your payout—small time, e go ready!`
        : `🎉 *Deposit Confirmed!* 🔄\n\n` +
          `*Amount:* ${amount} ${asset} on ${chainRaw}\n` +
          `*Reference ID:* \`${txData.referenceId}\`\n` +
          `*Transaction Hash:* \`${transactionHash}\`\n` +
          `Your deposit has been confirmed, ${userState.firstName || 'valued user'}! We’re processing your payout—it’ll be ready soon!`;
      await bot.telegram.editMessageCaption(txData.userId, txData.messageId, null, depositSweptMessage, { parse_mode: 'Markdown' });

      logger.info(`Deposit swept for user ${txData.userId}: Reference ID ${paycrestOrder.id}`);
      res.status(200).send('OK');
    } else {
      logger.info(`Unhandled Blockradar event type: ${eventType}`);
      res.status(200).send('OK');
    }
  } catch (error) {
    logger.error(`Error in Blockradar webhook handler: ${error.message}`);
    await bot.telegram.sendPhoto(PERSONAL_CHAT_ID, { source: ERROR_IMAGE }, {
      caption: `❗️ Error processing Blockradar webhook: ${error.message}`,
      parse_mode: 'Markdown'
    });
    res.status(500).send('Error processing webhook');
  }
});

// =================== Feedback Mechanism ===================
bot.action(/feedback_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const feedbackType = ctx.match[1];
    const userState = await getUserState(userId);
    const feedbackMessage = userState.usePidgin
      ? `*Thank you for your feedback o!*\n\n` +
        `You pick: ${feedbackType === 'great' ? 'Great o' : feedbackType === 'not_good' ? 'No good' : 'Suggestions'}.`
      : `*Thank you for your feedback!*\n\n` +
        `You selected: ${feedbackType === 'great' ? 'Great' : feedbackType === 'not_good' ? 'Not Good' : 'Suggestions'}.`;
    
    await ctx.editMessageCaption(feedbackMessage, { parse_mode: 'Markdown' });
    logger.info(`User ${userId} feedback: ${feedbackType}`);
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in feedback handler for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while processing your feedback. Please try again.');
    await ctx.answerCbQuery();
  }
});

// =================== Shutdown Handlers ===================
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// =================== Start Express Server ===================
app.use(WEBHOOK_PATH, bodyParser.json());

app.post(WEBHOOK_PATH, bodyParser.json(), async (req, res) => {
  try {
    if (!req.body) {
      logger.error('No body found in Telegram webhook request.');
      return res.status(400).send('No body found.');
    }

    const clientIp = requestIp.getClientIp(req);
    let location = 'Unknown';
    try {
      const geoResponse = await axios.get(`http://ip-api.com/json/${clientIp}`);
      if (geoResponse.data.status === 'success') {
        location = geoResponse.data.country;
      }
    } catch (error) {
      logger.error(`Error fetching geolocation for IP ${clientIp}: ${error.message}`);
    }

    req.session = req.session || {};
    req.session.location = location;

    logger.info(`Received Telegram update from ${location}: ${JSON.stringify(req.body, null, 2)}`);
    bot.handleUpdate(req.body, res);
  } catch (error) {
    logger.error(`Error in Telegram webhook handler: ${error.message}`);
    res.status(500).send('Error processing webhook');
  }
});

const SERVER_PORT = PORT;

app.listen(SERVER_PORT, () => {
  logger.info(`Webhook server running on port ${SERVER_PORT}`);
});
