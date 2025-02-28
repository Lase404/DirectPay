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
const requestIp = require('request-ip'); // For IP detection
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

// Image Paths (Replace with actual paths or Telegram file_ids)
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
    throw new Error('Failed to verify bank account. Please try again later.');
  }
}

async function createPaycrestOrder(userId, amount, token, network, recipientDetails, userSendAddress) {
  try {
    const paycrestMapping = mapToPaycrest(token, network);
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
      returnAddress: userSendAddress || PAYCREST_RETURN_ADDRESS,
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
    return orderResp.data.data;
  } catch (err) {
    logger.error(`Error creating Paycrest order: ${err.response ? err.response.data.message : err.message}`);
    throw new Error('Failed to create Paycrest order.');
  }
}

async function withdrawFromBlockradar(chain, assetId, address, amount, reference, metadata) {
  try {
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
        'x-api-key': chainData.key,
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

// =================== Define Scenes ===================

/**
 * ------------------ Bank Linking Scene ------------------
 */
const bankLinkingScene = new Scenes.WizardScene(
  'bank_linking_scene',
  async (ctx) => {
    if (!ctx.session) ctx.session = {};
    const userId = ctx.from.id.toString();
    const walletIndex = ctx.session.walletIndex;
    if (walletIndex === undefined || walletIndex === null) {
      await ctx.replyWithMarkdown('⚠️ No wallet selected for linking. Please generate a wallet first.');
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
    const bankNameInput = input.toLowerCase();
    const bank = bankList.find((b) => b.aliases.includes(bankNameInput));
    if (!bank) {
      const userState = await getUserState(userId);
      const errorMsg = userState.usePidgin
        ? '❌ Bank name no correct o! Abeg enter valid bank name from this list:\n\n' + bankList.map(b => `• ${b.name}`).join('\n')
        : '❌ Invalid bank name. Please enter a valid bank name from our supported list:\n\n' + bankList.map(b => `• ${b.name}`).join('\n');
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }
    ctx.session.bankData.bankName = bank.name;
    ctx.session.bankData.bankCode = bank.code;
    ctx.session.bankData.step = 2;
    const userState = await getUserState(userId);
    const prompt = userState.usePidgin
      ? '🔢 Enter your 10-digit account number. No dey waste time o, money dey wait!'
      : '🔢 Please enter your 10-digit bank account number:';
    await ctx.replyWithMarkdown(prompt);
    return ctx.wizard.next();
  },
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const input = ctx.message.text.trim();
    logger.info(`User ${userId} entered account number: ${input}`);
    if (!/^\d{10}$/.test(input)) {
      const userState = await getUserState(userId);
      const errorMsg = userState.usePidgin
        ? '❌ Account number no correct o! Abeg enter valid 10-digit number:'
        : '❌ Invalid account number. Please enter a valid 10-digit account number:';
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }
    ctx.session.bankData.accountNumber = input;
    ctx.session.bankData.step = 3;
    const userState = await getUserState(userId);
    const verifyingMsg = userState.usePidgin
      ? '🔄 Verifying your bank details... Relax, we dey check am like SARS dey check car papers!'
      : '🔄 Verifying your bank details...';
    await ctx.replyWithMarkdown(verifyingMsg);
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
      const confirmMsg = userState.usePidgin
        ? `🏦 *Bank Account Verification*\n\nPlease confirm your bank details:\n- *Bank Name:* ${ctx.session.bankData.bankName}\n- *Account Number:* ${ctx.session.bankData.accountNumber}\n- *Account Holder:* ${accountName}\n\nNa you be this abi na another person?`
        : `🏦 *Bank Account Verification*\n\nPlease confirm your bank details:\n- *Bank Name:* ${ctx.session.bankData.bankName}\n- *Account Number:* ${ctx.session.bankData.accountNumber}\n- *Account Holder:* ${accountName}\n\nIs this information correct?`;
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
        : '❌ Failed to verify your bank account. Please ensure your details are correct or try again later.';
      await ctx.replyWithMarkdown(errorMsg);
      return ctx.scene.leave();
    }
  },
  async (ctx) => {
    return; // Confirmation handled by actions
  }
);

bankLinkingScene.action('confirm_bank_yes', async (ctx) => {
  if (!ctx.session) ctx.session = {};
  const userId = ctx.from.id.toString();
  const bankData = ctx.session.bankData;
  const walletIndex = ctx.session.walletIndex;
  try {
    let userState = await getUserState(userId);
    const wallet = userState.wallets[walletIndex];
    if (!wallet) {
      const errorMsg = userState.usePidgin
        ? '⚠️ No wallet dey here o! Abeg generate wallet first.'
        : '⚠️ No wallet selected for linking. Please generate a wallet first.';
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
      ? `👏 *Bank Account Linked Successfully!*\n\nWelcome to DirectPay! Here’s your new wallet setup:\n\n*Wallet Address:* \`${wallet.address}\`\n*Supported Networks:* Base, BNB Smart Chain, Polygon (Matic)\n*Supported Assets:* USDC, USDT\n\n*Bank Name:* ${bankData.bankName}\n*Account Number:* ${bankData.accountNumber}\n*Account Holder:* ${bankData.accountName}\n\nOnly USDC and USDT dey work here o, no go send Shiba Inu unless you wan hear "Otilor!" from support. Scan the QR code to grab your address!`
      : `👏 *Bank Account Linked Successfully!*\n\nWelcome to DirectPay! Here are the details of your new wallet setup:\n\n*Wallet Address:* \`${wallet.address}\`\n*Supported Networks:* Base, BNB Smart Chain, Polygon (Matic)\n*Supported Assets:* USDC, USDT\n\n*Bank Name:* ${bankData.bankName}\n*Account Number:* ${bankData.accountNumber}\n*Account Holder:* ${bankData.accountName}\n\nPlease note, only USDC and USDT are supported across **Base, BNB Smart Chain, and Polygon**. If any other token is deposited, reach out to customer support for assistance. Scan the QR code below to copy your wallet address!`;
    const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=1000x1000&data=${encodeURIComponent(wallet.address)}`;
    const qrCodeResponse = await axios.get(qrCodeUrl, { responseType: 'arraybuffer' });
    const qrCodeBuffer = Buffer.from(qrCodeResponse.data);
    const qrCodePosition = { top: 1920, left: 1600 };
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
        ? `📋 One small question: This bank account wey you link (${bankData.accountName}), na for you or for another person?\n\n[✅ Na me o!] [❌ Na third party]`
        : `📋 One quick question: Is this bank account (${bankData.accountName}) yours or someone else’s?\n\n[✅ It’s mine!] [❌ It’s a third party’s]`;
      await ctx.replyWithMarkdown(namePrompt, Markup.inlineKeyboard([
        [Markup.button.callback(userState.usePidgin ? '✅ Na me o!' : '✅ It’s mine!', 'bank_is_mine')],
        [Markup.button.callback(userState.usePidgin ? '❌ Na third party' : '❌ It’s a third party’s', 'bank_is_third_party')],
      ]));
    } else {
      const mainMenu = getMainMenu(userState.wallets.length > 0);
      const menuText = userState.usePidgin
        ? `Here’s your menu, ${userState.firstName} wey sabi road:`
        : `Here’s your menu, ${userState.firstName}:`;
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
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🔗 User ${userId} linked a bank account:\n\n*Username:* @${ctx.from.username || 'N/A'}\n*First Name:* ${userState.firstName || 'Not set yet'}\n*Bank Name:* ${wallet.bank.bankName}\n*Account Number:* ${wallet.bank.accountNumber}\n*Account Holder:* ${wallet.bank.accountName}`, { parse_mode: 'Markdown' });
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
  if (!ctx.session) ctx.session = {};
  const userId = ctx.from.id.toString();
  const bankData = ctx.session.bankData;
  try {
    const userState = await getUserState(userId);
    const firstName = bankData.accountName.split(' ')[0];
    await updateUserState(userId, { firstName });
    const confirmMsg = userState.usePidgin
      ? `Ehen! Good choice, ${firstName}! We go dey call you ${firstName} from now on, sharp person wey sabi road. Here’s your menu:`
      : `Great! We’ll call you ${firstName} from now on. Here’s your menu, ${firstName}:`;
    const mainMenu = getMainMenu(userState.wallets.length > 0);
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
    await ctx.replyWithMarkdown('⚠️ Something went wrong o! Try again later.');
    await ctx.answerCbQuery();
    ctx.scene.leave();
  }
});

bankLinkingScene.action('bank_is_third_party', async (ctx) => {
  if (!ctx.session) ctx.session = {};
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const prompt = userState.usePidgin
    ? 'Okay! Who you be then? Abeg tell us your first name and last name so we fit know you well-well:\n(Reply with "FirstName LastName", e.g., "Chioma Eze")'
    : 'Alright! What’s your name then? Please provide your first name and last name so we can identify you:\n(Reply with "FirstName LastName", e.g., "Chioma Eze")';
  await ctx.replyWithMarkdown(prompt);
  ctx.session.awaitingName = true;
  await ctx.answerCbQuery();
});

bankLinkingScene.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (ctx.session.awaitingName) {
    const input = ctx.message.text.trim();
    const nameParts = input.split(' ');
    if (nameParts.length < 2) {
      const userState = await getUserState(userId);
      const errorMsg = userState.usePidgin
        ? '❌ E no complete o! Abeg give us your first name and last name together (e.g., "Chioma Eze").'
        : '❌ That’s not complete! Please provide both your first name and last name (e.g., "Chioma Eze").';
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }
    const firstName = nameParts[0];
    await updateUserState(userId, { firstName });
    const userState = await getUserState(userId);
    const confirmMsg = userState.usePidgin
      ? `Correct! From now on, we go dey call you ${firstName}, fine person wey dey run things! Here’s your menu:`
      : `Perfect! From now on, we’ll call you ${firstName}. Here’s your menu, ${firstName}:`;
    const mainMenu = getMainMenu(userState.wallets.length > 0);
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
  }
});

bankLinkingScene.action('confirm_bank_no', async (ctx) => {
  const userState = await getUserState(ctx.from.id.toString());
  const msg = userState.usePidgin
    ? '⚠️ Let’s try again!'
    : '⚠️ Let’s try again.';
  await ctx.replyWithMarkdown(msg);
  await ctx.scene.reenter();
  await ctx.answerCbQuery();
});

bankLinkingScene.action('cancel_bank_linking', async (ctx) => {
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
});

/**
 * ------------------ Send Message Scene ------------------
 */
const sendMessageScene = new Scenes.WizardScene(
  'send_message_scene',
  async (ctx) => {
    const userState = await getUserState(ctx.from.id.toString());
    const prompt = userState.usePidgin
      ? '📩 Abeg enter the User ID you wan message:'
      : '📩 Please enter the User ID you want to message:';
    await ctx.replyWithMarkdown(prompt);
    return ctx.wizard.next();
  },
  async (ctx) => {
    const userIdToMessage = ctx.message.text.trim();
    const userState = await getUserState(ctx.from.id.toString());
    if (!/^\d{5,15}$/.test(userIdToMessage)) {
      const errorMsg = userState.usePidgin
        ? '❌ User ID no correct o! Abeg enter valid number (5-15 digits):'
        : '❌ Invalid User ID. Please enter a valid numeric User ID (5-15 digits):';
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }
    const userDoc = await db.collection('users').doc(userIdToMessage).get();
    if (!userDoc.exists) {
      const errorMsg = userState.usePidgin
        ? '❌ No find this User ID o! Check am well or try another one:'
        : '❌ User ID not found. Please ensure the User ID is correct or try another one:';
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }
    ctx.session.userIdToMessage = userIdToMessage;
    const prompt = userState.usePidgin
      ? '📝 Abeg enter the message you wan send to this person. You fit add picture (receipt) join am:'
      : '📝 Please enter the message you want to send to the user. You can also attach an image (receipt) with your message:';
    await ctx.replyWithMarkdown(prompt);
    return ctx.wizard.next();
  },
  async (ctx) => {
    const userIdToMessage = ctx.session.userIdToMessage;
    const adminUserId = ctx.from.id.toString();
    const userState = await getUserState(adminUserId);
    if (ctx.message.photo) {
      const photoArray = ctx.message.photo;
      const highestResolutionPhoto = photoArray[photoArray.length - 1];
      const fileId = highestResolutionPhoto.file_id;
      const caption = ctx.message.caption || '';
      try {
        await bot.telegram.sendPhoto(userIdToMessage, fileId, { caption: caption, parse_mode: 'Markdown' });
        const successMsg = userState.usePidgin
          ? '✅ Photo message don go o!'
          : '✅ Photo message sent successfully.';
        await ctx.replyWithMarkdown(successMsg);
        logger.info(`Admin ${adminUserId} sent photo message to user ${userIdToMessage}. Caption: ${caption}`);
      } catch (error) {
        logger.error(`Error sending photo to user ${userIdToMessage}: ${error.message}`);
        const errorMsg = userState.usePidgin
          ? '⚠️ E no work o! Check if the User ID correct or if dem block the bot.'
          : '⚠️ Error sending photo. Please ensure the User ID is correct and the user has not blocked the bot.';
        await ctx.replyWithMarkdown(errorMsg);
      }
    } else if (ctx.message.text) {
      const messageContent = ctx.message.text.trim();
      if (!messageContent) {
        const errorMsg = userState.usePidgin
          ? '❌ Message no fit empty o! Abeg enter something:'
          : '❌ Message content cannot be empty. Please enter a valid message:';
        await ctx.reply(errorMsg);
        return;
      }
      try {
        const adminMsg = userState.usePidgin
          ? `📩 *Message from Admin:*\n\n${messageContent}`
          : `📩 *Message from Admin:*\n\n${messageContent}`;
        await bot.telegram.sendMessage(userIdToMessage, adminMsg, { parse_mode: 'Markdown' });
        const successMsg = userState.usePidgin
          ? '✅ Text message don go o!'
          : '✅ Text message sent successfully.';
        await ctx.replyWithMarkdown(successMsg);
        logger.info(`Admin ${adminUserId} sent text message to user ${userIdToMessage}: ${messageContent}`);
      } catch (error) {
        logger.error(`Error sending message to user ${userIdToMessage}: ${error.message}`);
        const errorMsg = userState.usePidgin
          ? '⚠️ E no work o! Check if the User ID correct or if dem block the bot.'
          : '⚠️ Error sending message. Please ensure the User ID is correct and the user has not blocked the bot.';
        await ctx.replyWithMarkdown(errorMsg);
      }
    } else {
      const errorMsg = userState.usePidgin
        ? '❌ This type no work o! Send text or photo abeg.'
        : '❌ Unsupported message type. Please send text or a photo (receipt).';
      await ctx.reply(errorMsg);
    }
    delete ctx.session.userIdToMessage;
    ctx.scene.leave();
  }
);

/**
 * ------------------ Wallet Rename Scene ------------------
 */
const walletRenameScene = new Scenes.WizardScene(
  'wallet_rename_scene',
  async (ctx) => {
    if (!ctx.session) ctx.session = {};
    const userState = await getUserState(ctx.from.id.toString());
    if (!userState.wallets || userState.wallets.length === 0) {
      await ctx.replyWithMarkdown(
        userState.usePidgin
          ? '❌ You no get wallet o! Generate one first.'
          : '❌ No wallet found. Please generate a wallet first.'
      );
      return ctx.scene.leave();
    }
    if (ctx.session.walletIndex === undefined) {
      if (userState.wallets.length === 1) {
        ctx.session.walletIndex = 0;
      } else {
        let keyboard = [];
        userState.wallets.forEach((wallet, index) => {
          keyboard.push([Markup.button.callback(`Wallet ${index + 1} - ${wallet.address.slice(0, 6)}...`, `rename_select_${index}`)]);
        });
        await ctx.replyWithMarkdown(
          userState.usePidgin
            ? 'Abeg choose which wallet you wan rename:'
            : 'Please select the wallet to rename:',
          Markup.inlineKeyboard(keyboard)
        );
        return;
      }
    }
    await ctx.replyWithMarkdown(
      userState.usePidgin
        ? 'Abeg enter new wallet name:'
        : 'Please enter the new wallet name:'
    );
    return ctx.wizard.next();
  },
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const newName = ctx.message.text.trim();
    if (!newName) {
      await ctx.replyWithMarkdown('❌ Wallet name cannot be empty. Please enter a valid name:');
      return;
    }
    let userState = await getUserState(userId);
    const walletIndex = ctx.session.walletIndex;
    if (walletIndex === undefined || walletIndex < 0 || walletIndex >= userState.wallets.length) {
      await ctx.replyWithMarkdown('❌ Invalid wallet selected.');
      return ctx.scene.leave();
    }
    userState.wallets[walletIndex].name = newName;
    await updateUserState(userId, { wallets: userState.wallets });
    await ctx.replyWithMarkdown(`✅ Wallet renamed successfully to *${newName}*.`);
    ctx.session.walletIndex = undefined;
    return ctx.scene.leave();
  }
);

bot.action(/rename_select_(\d+)/, async (ctx) => {
  if (!ctx.session) ctx.session = {};
  const index = parseInt(ctx.match[1], 10);
  ctx.session.walletIndex = index;
  await ctx.answerCbQuery(`Wallet ${index + 1} selected.`);
  await ctx.scene.enter('wallet_rename_scene');
});

/**
 * ------------------ Wallet Delete Scene ------------------
 */
const walletDeleteScene = new Scenes.WizardScene(
  'wallet_delete_scene',
  async (ctx) => {
    if (!ctx.session) ctx.session = {};
    const userId = ctx.from.id.toString();
    let userState = await getUserState(userId);
    if (!userState.wallets || userState.wallets.length === 0) {
      await ctx.replyWithMarkdown(
        userState.usePidgin
          ? '❌ You no get wallet o! Generate one first.'
          : 'No wallet found.'
      );
      return ctx.scene.leave();
    }
    if (ctx.session.walletIndex === undefined) {
      if (userState.wallets.length === 1) {
        ctx.session.walletIndex = 0;
      } else {
        let keyboard = userState.wallets.map((wallet, index) => [
          Markup.button.callback(`Wallet ${index + 1} - ${wallet.address.slice(0, 6)}...`, `delete_select_${index}`)
        ]);
        await ctx.replyWithMarkdown(
          userState.usePidgin
            ? 'Abeg choose which wallet you wan delete:'
            : 'Please select the wallet to delete:',
          Markup.inlineKeyboard(keyboard)
        );
        return;
      }
    }
    const wallet = userState.wallets[ctx.session.walletIndex];
    await ctx.replyWithMarkdown(
      userState.usePidgin
        ? `⚠️ You sure say you wan delete wallet *${wallet.name || wallet.address}*? This action no fit be undone.\n\nPress ✅ to confirm or ❌ to cancel.`
        : `⚠️ Are you sure you want to delete wallet *${wallet.name || wallet.address}*? This action cannot be undone.\n\nPress ✅ to confirm or ❌ to cancel.`,
      Markup.inlineKeyboard([
        [Markup.button.callback(userState.usePidgin ? '✅ Yes, delete' : '✅ Yes, delete', 'delete_confirm')],
        [Markup.button.callback(userState.usePidgin ? '❌ Cancel' : '❌ Cancel', 'delete_cancel')]
      ])
    );
    return ctx.wizard.next();
  },
  async (ctx) => {
    return ctx.scene.leave();
  }
);

bot.action('wallet_delete', async (ctx) => {
  if (!ctx.session) ctx.session = {};
  await ctx.answerCbQuery('Delete option selected (implementing now)...', { show_alert: true });
  await ctx.scene.enter('wallet_delete_scene');
});

bot.action(/delete_select_(\d+)/, async (ctx) => {
  if (!ctx.session) ctx.session = {};
  const index = parseInt(ctx.match[1], 10);
  ctx.session.walletIndex = index;
  await ctx.answerCbQuery(`Wallet ${index + 1} selected.`);
  await ctx.scene.enter('wallet_delete_scene');
});

bot.action('delete_confirm', async (ctx) => {
  if (!ctx.session) ctx.session = {};
  const userId = ctx.from.id.toString();
  let userState = await getUserState(userId);
  const walletIndex = ctx.session.walletIndex;
  if (walletIndex === undefined || walletIndex < 0 || walletIndex >= userState.wallets.length) {
    await ctx.answerCbQuery('Invalid wallet selected.', { show_alert: true });
    return;
  }
  userState.wallets.splice(walletIndex, 1);
  userState.walletAddresses.splice(walletIndex, 1);
  await updateUserState(userId, { wallets: userState.wallets, walletAddresses: userState.walletAddresses });
  await ctx.replyWithMarkdown(
    userState.usePidgin
      ? '✅ Wallet don delete successfully.'
      : '✅ Wallet deleted successfully.'
  );
  ctx.session.walletIndex = undefined;
  await ctx.answerCbQuery();
  return ctx.scene.leave();
});

bot.action('delete_cancel', async (ctx) => {
  if (!ctx.session) ctx.session = {};
  await ctx.replyWithMarkdown(
    ctx.session.usePidgin
      ? 'Wallet deletion canceled.'
      : 'Wallet deletion canceled.'
  );
  ctx.session.walletIndex = undefined;
  await ctx.answerCbQuery();
  return ctx.scene.leave();
});

// =================== Register Scenes with Stage ===================
const stage = new Scenes.Stage();
stage.register(bankLinkingScene, sendMessageScene, walletRenameScene, walletDeleteScene);

// =================== Apply Middlewares ===================
bot.use(session());
bot.use(stage.middleware());

// =================== Exchange Rate Fetching ===================
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
setInterval(fetchExchangeRates, 300000);

async function fetchCoinGeckoRates() {
  try {
    const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=usd-coin,tether&vs_currencies=ngn');
    return {
      USDC: response.data['usd-coin'].ngn,
      USDT: response.data.tether.ngn
    };
  } catch (error) {
    logger.error(`Error fetching CoinGecko rates: ${error.message}`);
    return { USDC: 0, USDT: 0 };
  }
}

// =================== Main Menu ===================
const getMainMenu = (hasWallets = false) =>
  Markup.keyboard([
    [hasWallets ? '💼 View Wallet' : '💼 Generate Wallet', '⚙️ Settings'],
    ['💰 Transactions', 'ℹ️ Support', '📘 Learn About Base'],
    ['📈 View Current Rates'],
  ]).resize();

// =================== Check if User is Admin ===================
const isAdmin = (userId) => ADMIN_IDS.split(',').map(id => id.trim()).includes(userId.toString());

/**
 * ------------------ Personalized Greeting ------------------
 */
async function greetUser(ctx) {
  const userId = ctx.from.id.toString();
  let userState;
  try {
    userState = await getUserState(userId);
    if (!userState.firstName && ctx.from.first_name) {
      await updateUserState(userId, { firstName: ctx.from.first_name });
      userState.firstName = ctx.from.first_name;
    }
  } catch (error) {
    logger.error(`Error fetching user state for ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
    return;
  }
  const currentHour = new Date().getHours();
  let timeGreeting = "";
  if (currentHour < 12) timeGreeting = "Good morning";
  else if (currentHour < 18) timeGreeting = "Good afternoon";
  else timeGreeting = "Good evening";
  const personalizedGreeting = userState.firstName ? `${timeGreeting}, ${userState.firstName}!` : `${timeGreeting}, valued user!`;
  const greeting = `${personalizedGreeting}\n\nThank you for choosing **DirectPay**. Here, we convert your cryptocurrency to cash swiftly and securely. Let’s get started:`;
  const mainMenu = getMainMenu(userState.wallets && userState.wallets.length > 0);
  await ctx.replyWithMarkdown(greeting, { reply_markup: mainMenu.reply_markup });
  const location = ctx.session?.location || 'Nigeria';
  if (location === 'Nigeria' && !userState.usePidgin) {
    await ctx.reply('By the way, we notice you might be in Nigeria. Want to switch to Pidgin for a more local vibe? Just say "Pidgin" anytime!');
  }
  if (isAdmin(userId)) {
    const adminText = userState.usePidgin
      ? `Admin options, ${userState.firstName || 'boss'}:`
      : `Admin options, ${userState.firstName || 'esteemed user'}:`;
    await ctx.reply(adminText, Markup.inlineKeyboard([
      [Markup.button.callback('🔧 Admin Panel', 'open_admin_panel')]
    ]));
  }
}

bot.start(async (ctx) => {
  try {
    await greetUser(ctx);
  } catch (error) {
    logger.error(`Error in /start command: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
  }
});

bot.hears('Pidgin', async (ctx) => {
  const userId = ctx.from.id.toString();
  await updateUserState(userId, { usePidgin: true });
  const userState = await getUserState(userId);
  const confirmMsg = userState.firstName
    ? `Ehen! ${userState.firstName}, we don switch to Pidgin for you o! Here’s your menu again, Naija style:`
    : `Ehen! We don switch to Pidgin for you o, my friend! Here’s your menu again, Naija style:`;
  const mainMenu = getMainMenu(userState.wallets && userState.wallets.length > 0);
  await ctx.replyWithMarkdown(confirmMsg, { reply_markup: mainMenu.reply_markup });
  if (isAdmin(userId)) {
    const adminText = userState.firstName
      ? `Admin options, ${userState.firstName} the boss:`
      : `Admin options, big boss:`;
    await ctx.reply(adminText, Markup.inlineKeyboard([
      [Markup.button.callback('🔧 Admin Panel', 'open_admin_panel')]
    ]));
  }
});

// =================== Generate Wallet Handler ===================
async function handleGenerateWallet(ctx) {
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
      : '🔄 *Generating Wallet...* Hold on!';
    const pendingMessage = await ctx.replyWithMarkdown(pendingMsg);
    const chain = 'Base';
    const walletAddress = await generateWallet(chain);
    userState.wallets.push({
      address: walletAddress,
      chain: chain,
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
      ? `✅ *Wallet Generated Successfully!*\n\n*Supported Networks:* Base, BNB Smart Chain, Polygon (Matic)\n*Supported Assets:* USDC, USDT\n\nAbeg link your bank account quick-quick so we fit show you this wallet address. No dey send Ethereum o, na only USDC/USDT we dey chop here!`
      : `✅ *Wallet Generated Successfully!*\n\n*Supported Networks:* Base, BNB Smart Chain, Polygon (Matic)\n*Supported Assets:* USDC, USDT\n\nPlease link a bank account to proceed. Your wallet address will be revealed once your bank details are confirmed. If you deposit any token other than USDC/USDT, please contact customer support to retrieve it.`;
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
}

bot.hears('💼 Generate Wallet', async (ctx) => {
  await handleGenerateWallet(ctx);
});

bot.hears('💼 View Wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    if (userState.wallets.length === 0) {
      const errorMsg = userState.usePidgin
        ? '❌ You no get wallet o! Abeg generate one with "💼 Generate Wallet".'
        : '❌ You have no wallets. Please generate a wallet first using the "💼 Generate Wallet" option.';
      return ctx.replyWithMarkdown(errorMsg);
    }
    let message = userState.usePidgin
      ? `💼 *Your Wallets* 💰\n\n`
      : `💼 *Your Wallets* 💰\n\n`;
    userState.wallets.forEach((wallet, index) => {
      message += `🌟 *Wallet #${index + 1}*\n🔹 *Address:* \`${wallet.address}\`\n🔹 *Network:* ${wallet.chain}\n🔹 *Supported Assets:*\n   - ✅ USDC\n   - ✅ USDT\n🔹 *Bank Linked:* ${wallet.bank ? '✅ Yes' : '❌ No'}\n`;
      if (wallet.bank) {
        message += `🔹 *Bank Details:*\n   - 🏦 *Bank:* ${wallet.bank.bankName}\n   - 💳 *Account Number:* ****${wallet.bank.accountNumber.slice(-4)}\n   - 👤 *Holder:* ${wallet.bank.accountName}\n`;
      }
      message += `🔹 *Creation Date:* ${new Date(wallet.creationDate).toLocaleString()}\n🔹 *Total Deposits:* ${wallet.totalDeposits || 0} USDC/USDT\n🔹 *Total Payouts:* ₦${wallet.totalPayouts || 0}\n\n`;
    });
    const sentMessage = await ctx.replyWithMarkdown(message, Markup.inlineKeyboard([
      [Markup.button.callback('⚙️ Manage Wallet', 'manage_wallet')]
    ]));
    ctx.session.viewWalletMessageId = sentMessage.message_id;
  } catch (error) {
    logger.error(`Error handling View Wallet for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '⚠️ E no work o! Try again later abeg.'
      : '⚠️ An error occurred while fetching your wallets. Please try again later.';
    await ctx.replyWithMarkdown(errorMsg);
  }
});

bot.action('manage_wallet', async (ctx) => {
  if (!ctx.session) ctx.session = {};
  const manageMenu = Markup.inlineKeyboard([
    [Markup.button.callback('✏️ Rename', 'wallet_rename')],
    [Markup.button.callback('🏦 Edit Bank', 'wallet_edit_bank')],
    [Markup.button.callback('🗑️ Delete', 'wallet_delete')],
    [Markup.button.callback('🔙 Back', 'wallet_back')]
  ]);
  const userState = await getUserState(ctx.from.id.toString());
  const menuText = userState.usePidgin ? 'Select an option for wallet management:' : 'Wallet Management Options:';
  await ctx.telegram.editMessageText(ctx.from.id, ctx.session.viewWalletMessageId, null, menuText, {
    parse_mode: 'Markdown',
    reply_markup: manageMenu.reply_markup
  });
  await ctx.answerCbQuery();
});

bot.action('wallet_back', async (ctx) => {
  const userState = await getUserState(ctx.from.id.toString());
  let message = userState.usePidgin
    ? `💼 *Your Wallets* 💰\n\n`
    : `💼 *Your Wallets* 💰\n\n`;
  userState.wallets.forEach((wallet, index) => {
    message += `🌟 *Wallet #${index + 1}*\n🔹 *Address:* \`${wallet.address}\`\n🔹 *Network:* ${wallet.chain}\n🔹 *Supported Assets:*\n   - ✅ USDC\n   - ✅ USDT\n🔹 *Bank Linked:* ${wallet.bank ? '✅ Yes' : '❌ No'}\n`;
    if (wallet.bank) {
      message += `🔹 *Bank Details:*\n   - 🏦 *Bank:* ${wallet.bank.bankName}\n   - 💳 *Account Number:* ****${wallet.bank.accountNumber.slice(-4)}\n   - 👤 *Holder:* ${wallet.bank.accountName}\n`;
    }
    message += `🔹 *Creation Date:* ${new Date(wallet.creationDate).toLocaleString()}\n🔹 *Total Deposits:* ${wallet.totalDeposits || 0} USDC/USDT\n🔹 *Total Payouts:* ₦${wallet.totalPayouts || 0}\n\n`;
  });
  await ctx.telegram.editMessageText(ctx.from.id, ctx.session.viewWalletMessageId, null, message, {
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback('⚙️ Manage Wallet', 'manage_wallet')]
    ]).reply_markup
  });
  await ctx.answerCbQuery();
});

bot.action('wallet_rename', async (ctx) => {
  if (!ctx.session) ctx.session = {};
  await ctx.answerCbQuery('Rename option selected (implementing now)...', { show_alert: true });
  await ctx.scene.enter('wallet_rename_scene');
});
bot.action('wallet_edit_bank', async (ctx) => {
  if (!ctx.session) ctx.session = {};
  const userId = ctx.from.id.toString();
  let userState = await getUserState(userId);
  if (!userState.wallets || userState.wallets.length === 0) {
    await ctx.answerCbQuery();
    return ctx.replyWithMarkdown(
      userState.usePidgin
        ? '❌ You no get wallet o! Abeg generate one.'
        : 'No wallet found. Please generate a wallet first.'
    );
  }
  if (userState.wallets.length === 1) {
    ctx.session.walletIndex = 0;
    await ctx.scene.enter('bank_linking_scene');
    await ctx.answerCbQuery();
  } else {
    let keyboard = userState.wallets.map((wallet, index) => [
      Markup.button.callback(`Wallet ${index + 1} - ${wallet.address.slice(0, 6)}...`, `edit_bank_select_${index}`)
    ]);
    await ctx.replyWithMarkdown(
      userState.usePidgin
        ? 'Abeg pick the wallet wey you wan edit the bank details:'
        : 'Please select the wallet for which you want to edit the bank details:',
      Markup.inlineKeyboard(keyboard)
    );
    await ctx.answerCbQuery();
  }
});

bot.action(/edit_bank_select_(\d+)/, async (ctx) => {
  if (!ctx.session) ctx.session = {};
  const index = parseInt(ctx.match[1], 10);
  ctx.session.walletIndex = index;
  await ctx.answerCbQuery(`Wallet ${index + 1} selected.`);
  await ctx.scene.enter('bank_linking_scene');
});

bot.action('wallet_delete', async (ctx) => {
  if (!ctx.session) ctx.session = {};
  await ctx.answerCbQuery('Delete option selected (implementing now)...', { show_alert: true });
  await ctx.scene.enter('wallet_delete_scene');
});

// =================== Settings Handler ===================
bot.hears('⚙️ Settings', async (ctx) => {
  const userState = await getUserState(ctx.from.id.toString());
  const menuText = userState.usePidgin
    ? '⚙️ *Settings Menu*'
    : '⚙️ *Settings Menu*';
  await ctx.reply(menuText, getSettingsMenu());
});

const getSettingsMenu = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Generate New Wallet', 'settings_generate_wallet')],
    [Markup.button.callback('✏️ Edit Linked Bank Details', 'settings_edit_bank')],
    [Markup.button.callback('💬 Support', 'settings_support')],
    [Markup.button.callback('🔙 Back to Main Menu', 'settings_back_main')],
  ]);

bot.action('settings_generate_wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    if (userState.wallets.length >= MAX_WALLETS) {
      const errorMsg = userState.usePidgin
        ? `⚠️ You don reach max wallets o (${MAX_WALLETS})! Manage the ones you get first abeg.`
        : `⚠️ You have reached the maximum number of wallets (${MAX_WALLETS}). Please manage your existing wallets before adding new ones.`;
      return ctx.replyWithMarkdown(errorMsg);
    }
    await handleGenerateWallet(ctx);
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error handling Generate New Wallet in Settings for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '⚠️ E no work o! Try again later abeg.'
      : '⚠️ An error occurred while generating your wallet. Please try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
  }
});

bot.action('settings_edit_bank', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    if (!userState.wallets || userState.wallets.length === 0) {
      const errorMsg = userState.usePidgin
        ? '❌ You no get wallets o! Abeg generate one with "💼 Generate Wallet".'
        : '❌ You have no wallets. Please generate a wallet first using the "💼 Generate Wallet" option.';
      return ctx.replyWithMarkdown(errorMsg);
    }
    if (userState.wallets.length === 1) {
      ctx.session.walletIndex = 0;
      await ctx.scene.enter('bank_linking_scene');
    } else {
      let keyboard = userState.wallets.map((wallet, index) => [
        Markup.button.callback(`Wallet ${index + 1} - ${wallet.address.slice(0, 6)}...`, `select_wallet_edit_bank_${index}`)
      ]);
      const prompt = userState.usePidgin
        ? 'Abeg pick the wallet wey you wan edit the bank details:'
        : 'Please select the wallet for which you want to edit the bank details:';
      await ctx.reply(prompt, Markup.inlineKeyboard(keyboard));
    }
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error handling Edit Linked Bank Details in Settings for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '⚠️ E no work o! Try again later abeg.'
      : '⚠️ An error occurred while editing your bank details. Please try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
  }
});

bot.action(/select_wallet_edit_bank_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);
  if (isNaN(walletIndex)) {
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '⚠️ Wallet pick no work o! Try again abeg.'
      : '⚠️ Invalid wallet selection. Please try again.';
    await ctx.replyWithMarkdown(errorMsg);
    return ctx.answerCbQuery();
  }
  ctx.session.walletIndex = walletIndex;
  await ctx.scene.enter('bank_linking_scene');
  ctx.answerCbQuery();
});

bot.action('settings_support', async (ctx) => {
  const userState = await getUserState(ctx.from.id.toString());
  const prompt = userState.usePidgin
    ? '🛠️ *Support Section*\n\nPick one option below o:'
    : '🛠️ *Support Section*\n\nSelect an option below:';
  await ctx.replyWithMarkdown(prompt, Markup.inlineKeyboard([
    [Markup.button.callback('❓ How It Works', 'support_how_it_works')],
    [Markup.button.callback('⚠️ Transaction Not Received', 'support_not_received')],
    [Markup.button.callback('💬 Contact Support', 'support_contact')],
  ]));
});

bot.action('settings_back_main', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    const mainMenu = getMainMenu(userState.wallets && userState.wallets.length > 0);
    const menuText = userState.usePidgin
      ? userState.firstName
        ? `Welcome back to the main menu, ${userState.firstName} wey sabi!`
        : 'Welcome back to the main menu, my friend!'
      : userState.firstName
        ? `Welcome back to the main menu, ${userState.firstName}!`
        : 'Welcome back to the main menu!';
    await ctx.replyWithMarkdown(menuText, { reply_markup: mainMenu.reply_markup });
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
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error returning to main menu for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '⚠️ E no work o! Try again later abeg.'
      : '⚠️ An error occurred. Please try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    ctx.answerCbQuery();
  }
});

bot.hears(/📘\s*Learn About Base/i, async (ctx) => {
  await sendBaseContent(ctx, 0, true);
});

const baseContent = [
  {
    english: {
      title: 'Welcome to Base',
      text: 'Base is a secure, low-cost, and developer-friendly Ethereum Layer 2 network. It offers a seamless way to onboard into the world of decentralized applications.'
    },
    pidgin: {
      title: 'Welcome to Base',
      text: 'Base na one kind secure, cheap, and developer-friendly Ethereum Layer 2 network. E dey make joining the world of decentralized apps easy like ABC!'
    }
  },
  {
    english: {
      title: 'Why Choose Base?',
      text: '- **Lower Fees**: Significantly reduced transaction costs.\n- **Faster Transactions**: Swift confirmation times.\n- **Secure**: Built on Ethereum’s robust security.\n- **Developer-Friendly**: Compatible with EVM tools and infrastructure.'
    },
    pidgin: {
      title: 'Why Pick Base?',
      text: '- **Small Fees**: Transaction costs don reduce like mad, e no be like ETH wey go dey charge $100 untop $5 transaction.\n- **Fast Transactions**: Confirmation dey quick like flash.\n- **Secure**: E stand on Ethereum strong security.\n- **Developer-Friendly**: E fit work with EVM tools and setup.'
    }
  },
  {
    english: {
      title: 'Getting Started',
      text: 'To start using Base, you can bridge your assets from Ethereum to Base using the official bridge at [Bridge Assets to Base](https://base.org/bridge).'
    },
    pidgin: {
      title: 'How to Start',
      text: 'To begin use Base, you fit bridge your assets from Ethereum to Base with the official bridge here: [Bridge Assets to Base](https://base.org/bridge).'
    }
  },
  {
    english: {
      title: 'Learn More',
      text: 'Visit the official documentation at [Base Documentation](https://docs.base.org) for in-depth guides and resources.'
    },
    pidgin: {
      title: 'Sabi More',
      text: 'Check the official documentation here [Base Documentation](https://docs.base.org) for deep gist and resources.'
    }
  }
];

async function sendBaseContent(ctx, index, isNew = true) {
  const userState = await getUserState(ctx.from.id.toString());
  const content = userState.usePidgin ? baseContent[index].pidgin : baseContent[index].english;
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
    ctx.session.baseMessageId = sentMessage.message_id;
  } else {
    try {
      await ctx.editMessageText(`**${content.title}**\n\n${content.text}`, {
        parse_mode: 'Markdown',
        reply_markup: inlineKeyboard.reply_markup,
      });
    } catch (error) {
      const sentMessage = await ctx.replyWithMarkdown(`**${content.title}**\n\n${content.text}`, inlineKeyboard);
      ctx.session.baseMessageId = sentMessage.message_id;
    }
  }
}

bot.action(/base_page_(\d+)/, async (ctx) => {
  const index = parseInt(ctx.match[1], 10);
  if (isNaN(index) || index < 0 || index >= baseContent.length) {
    return ctx.answerCbQuery('⚠️ Invalid page number.', { show_alert: true });
  }
  await sendBaseContent(ctx, index, false);
  ctx.answerCbQuery();
});

bot.action('exit_base', async (ctx) => {
  const userState = await getUserState(ctx.from.id.toString());
  if (ctx.session.baseMessageId) {
    await ctx.deleteMessage(ctx.session.baseMessageId).catch(() => {});
    ctx.session.baseMessageId = null;
  }
  const exitMsg = userState.usePidgin
    ? 'You be sabi guy!'
    : 'Thank you for learning about Base!';
  await ctx.replyWithMarkdown(exitMsg);
  ctx.answerCbQuery();
});

bot.hears(/ℹ️\s*Support/i, async (ctx) => {
  const userState = await getUserState(ctx.from.id.toString());
  const prompt = userState.usePidgin
    ? '🛠️ *Support Section*\n\nPick one option below o:'
    : '🛠️ *Support Section*\n\nSelect an option below:';
  await ctx.replyWithMarkdown(prompt, Markup.inlineKeyboard([
    [Markup.button.callback('❓ How It Works', 'support_how_it_works')],
    [Markup.button.callback('⚠️ Transaction Not Received', 'support_not_received')],
    [Markup.button.callback('💬 Contact Support', 'support_contact')],
  ]));
});

bot.action('support_how_it_works', async (ctx) => {
  const userState = await getUserState(ctx.from.id.toString());
  const text = userState.usePidgin
    ? detailedTutorials.how_it_works.pidgin
    : detailedTutorials.how_it_works.english;
  await ctx.replyWithMarkdown(text);
  ctx.answerCbQuery();
});

bot.action('support_not_received', async (ctx) => {
  const userState = await getUserState(ctx.from.id.toString());
  const text = userState.usePidgin
    ? detailedTutorials.transaction_guide.pidgin
    : detailedTutorials.transaction_guide.english;
  await ctx.replyWithMarkdown(text);
  ctx.answerCbQuery();
});

bot.action('support_contact', async (ctx) => {
  const userState = await getUserState(ctx.from.id.toString());
  const text = userState.usePidgin
    ? 'You fit chat our support team for [@maxcswap](https://t.me/maxcswap) anytime o.'
    : 'You can contact our support team at [@maxcswap](https://t.me/maxcswap).';
  await ctx.replyWithMarkdown(text);
  ctx.answerCbQuery();
});

bot.hears(/💰\s*Transactions/i, async (ctx) => {
  const userId = ctx.from.id.toString();
  const pageSize = 5;
  let page = 1;
  let filter = 'all';
  let asset = 'All';
  const filterOptions = ['all', 'Completed', 'Pending', 'Failed'];
  const assetOptions = ['USDC', 'USDT', 'All'];
  if (ctx.session.transactionsPage) {
    page = ctx.session.transactionsPage;
    filter = ctx.session.transactionsFilter || 'all';
    asset = ctx.session.transactionsAsset || 'All';
  }
  try {
    const userState = await getUserState(userId);
    let query = db.collection('transactions').where('userId', '==', userId).orderBy('timestamp', 'desc');
    if (filter !== 'all') {
      query = query.where('status', '==', filter);
    }
    if (asset !== 'All') {
      query = query.where('asset', '==', asset);
    }
    const transactionsSnapshot = await query.limit(pageSize * page).get();
    const transactionsCount = transactionsSnapshot.size;
    const transactions = transactionsSnapshot.docs.slice(-pageSize);
    let message = userState.usePidgin
      ? `💰 *Transaction History* (Page ${page}) 💸\n\n`
      : `💰 *Transaction History* (Page ${page}) 💸\n\n`;
    transactions.forEach((doc, index) => {
      const tx = doc.data();
      message += `🌟 *Transaction #${index + 1}*\n🔹 *Reference ID:* \`${tx.referenceId}\`\n🔹 *Status:* ${tx.status === 'Completed' ? '✅ Completed' : tx.status === 'Pending' ? '⏳ Pending' : '❌ Failed'}\n🔹 *Deposit Amount:* ${tx.amount} ${tx.asset}\n🔹 *Network:* ${tx.chain}\n🔹 *Exchange Rate:* ₦${exchangeRates[tx.asset] || 'N/A'}/${tx.asset} (Blockradar)\n🔹 *Payout Amount:* ₦${tx.payout || 'N/A'}\n🔹 *Bank Details:*\n   - 🏦 *Bank:* ${tx.bankDetails.bankName}\n   - 💳 *Account:* ****${tx.bankDetails.accountNumber.slice(-4)}\n   - 👤 *Holder:* ${tx.bankDetails.accountName}\n🔹 *Timestamp:* ${new Date(tx.timestamp).toLocaleString()}\n🔹 *Tx Hash:* \`${tx.transactionHash}\`\n\n`;
    });
    const totalPages = Math.ceil(transactionsCount / pageSize);
    const navigationButtons = [
      Markup.button.callback('⬅️ Previous', `transactions_page_${Math.max(1, page - 1)}_${filter}_${asset}`),
      Markup.button.callback('Next ➡️', `transactions_page_${Math.min(totalPages, page + 1)}_${filter}_${asset}`),
      Markup.button.callback('🔄 Refresh', `transactions_page_${page}_${filter}_${asset}`)
    ];
    const filterButtons = filterOptions.map(status => 
      Markup.button.callback(status.charAt(0).toUpperCase() + status.slice(1), `transactions_filter_${status}_${asset}`)
    );
    const assetButtons = assetOptions.map(asset => 
      Markup.button.callback(asset, `transactions_filter_${filter}_${asset}`)
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
    logger.error(`Error fetching transactions for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '⚠️ E no work o! Try again later abeg.'
      : '⚠️ Unable to fetch transactions. Please try again later.';
    await ctx.replyWithMarkdown(errorMsg);
  }
});

bot.action(/transactions_page_(\d+)_([^_]+)_([^_]+)/, async (ctx) => {
  ctx.session.transactionsPage = parseInt(ctx.match[1], 10);
  ctx.session.transactionsFilter = ctx.match[2];
  ctx.session.transactionsAsset = ctx.match[3];
  await ctx.answerCbQuery();
  await bot.hears('💰 Transactions')(ctx);
});

bot.action(/transactions_filter_([^_]+)_([^_]+)/, async (ctx) => {
  ctx.session.transactionsFilter = ctx.match[1];
  ctx.session.transactionsAsset = ctx.match[2];
  ctx.session.transactionsPage = 1;
  await ctx.answerCbQuery();
  await bot.hears('💰 Transactions')(ctx);
});

bot.hears('📈 View Current Rates', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    const coingeckoRates = await fetchCoinGeckoRates();
    const now = new Date().toLocaleTimeString('en-US', { timeZone: 'Africa/Lagos', hour12: false });
    const date = new Date().toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' });
    let ratesMessage = userState.usePidgin
      ? `📈 *Current Exchange Rates (${now} WAT, ${date})*\n\n`
      : `📈 *Current Exchange Rates (${now} WAT, ${date})*\n\n`;
    const userName = userState.firstName || 'sharp person';
    for (const asset of SUPPORTED_ASSETS) {
      const paycrestRate = exchangeRates[asset];
      const coingeckoRate = coingeckoRates[asset];
      const diff = paycrestRate - coingeckoRate;
      let funnyComment = '';
      if (userState.usePidgin) {
        if (diff > 0) {
          const profit = diff * 100;
          funnyComment = `*Ehen, ${userName}! DirectPay dey give you ₦${profit.toFixed(2)} extra for 100 ${asset}. Na we dey hold the pepper soup, others dey lick empty plate!*`;
        } else if (diff < 0) {
          const loss = Math.abs(diff) * 100;
          funnyComment = `*Chai, ${userName}! Market dey try beat us with ₦${loss.toFixed(2)} for 100 ${asset}, but DirectPay still dey your back o!, e sha better pass make one egbon scam you through p2p*`;
        } else {
          funnyComment = `*No wahala, ${userName}! Rates dey match like twins. DirectPay still dey with you solid!*`;
        }
      } else {
        if (diff > 0) {
          const profit = diff * 100;
          funnyComment = `*Great news, ${userName}! DirectPay offers you an extra ₦${profit.toFixed(2)} for 100 ${asset} compared to the market. We’re the best deal around!*`;
        } else if (diff < 0) {
          const loss = Math.abs(diff) * 100;
          funnyComment = `*Oh no, ${userName}! The market’s ahead by ₦${loss.toFixed(2)} for 100 ${asset}, but stick with DirectPay—we’ve got your back!*`;
        } else {
          funnyComment = `*All good, ${userName}! Rates are neck-and-neck. DirectPay’s still your solid choice!*`;
        }
      }
      ratesMessage += `• *${asset}*\n  - DirectPay Rate: ₦${paycrestRate.toFixed(2)}\n  - CoinGecko Rate: ₦${coingeckoRate.toFixed(2)}\n  - ${funnyComment}\n\n`;
    }
    ratesMessage += userState.usePidgin
      ? `No dulling o, ${userName}! DirectPay rates dey shine pass market wahala!`
      : `Stay smart, ${userName}! DirectPay’s rates beat the market every time!`;
    await ctx.replyWithMarkdown(ratesMessage, getMainMenu(userState.wallets && userState.wallets.length > 0));
  } catch (error) {
    logger.error(`Error fetching rates for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '⚠️ E no work o! Try again later abeg.'
      : '⚠️ Unable to fetch current rates. Please try again later.';
    await ctx.replyWithMarkdown(errorMsg);
  }
});

bot.action('open_admin_panel', async (ctx) => {
  const userId = ctx.from.id.toString();
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
  const sentMessage = await ctx.reply(menuText, getAdminMenu());
  ctx.session.adminMessageId = sentMessage.message_id;
  await ctx.answerCbQuery();
});

const getAdminMenu = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('📋 View Recent Transactions', 'admin_view_transactions')],
    [Markup.button.callback('📨 Send Message to User', 'admin_send_message')],
    [Markup.button.callback('✅ Mark Transactions as Paid', 'admin_mark_paid')],
    [Markup.button.callback('👥 View All Users', 'admin_view_users')],
    [Markup.button.callback('📢 Broadcast Message', 'admin_broadcast_message')],
    [Markup.button.callback('🔙 Back to Main Menu', 'admin_back_to_main')],
  ]);

bot.action(/admin_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
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
  switch (action) {
    case 'view_transactions':
      try {
        const transactionsSnapshot = await db.collection('transactions').orderBy('timestamp', 'desc').limit(10).get();
        if (transactionsSnapshot.empty) {
          await ctx.answerCbQuery(userState.usePidgin ? 'No transactions dey o.' : 'No transactions found.', { show_alert: true });
          return;
        }
        let message = userState.usePidgin
          ? '📋 **Recent Transactions**:\n\n'
          : '📋 **Recent Transactions**:\n\n';
        transactionsSnapshot.forEach((doc) => {
          const tx = doc.data();
          message += `*User ID:* ${tx.userId || 'N/A'}\n*Reference ID:* \`${tx.referenceId || 'N/A'}\`\n*Amount Deposited:* ${tx.amount || 'N/A'} ${tx.asset || 'N/A'}\n*Status:* ${tx.status || 'Pending'}\n*Chain:* ${tx.chain || 'N/A'}\n*Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n\n`;
        });
        const inlineKeyboard = Markup.inlineKeyboard([
          [Markup.button.callback(userState.usePidgin ? '🔙 Back to Admin Menu' : '🔙 Back to Admin Menu', 'admin_back_to_main')]
        ]);
        await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: inlineKeyboard.reply_markup });
        ctx.answerCbQuery();
      } catch (error) {
        logger.error(`Error fetching all transactions: ${error.message}`);
        await ctx.answerCbQuery(userState.usePidgin ? '⚠️ No fit fetch transactions o.' : '⚠️ Unable to fetch transactions.', { show_alert: true });
      }
      break;
    case 'send_message':
      try {
        const usersSnapshot = await db.collection('users').get();
        if (usersSnapshot.empty) {
          const errorMsg = userState.usePidgin
            ? '⚠️ No users dey to send message o.'
            : '⚠️ No users found to send messages.';
          await ctx.replyWithMarkdown(errorMsg);
          return ctx.answerCbQuery();
        }
        await ctx.scene.enter('send_message_scene');
        ctx.answerCbQuery();
      } catch (error) {
        logger.error(`Error initiating send message: ${error.message}`);
        const errorMsg = userState.usePidgin
          ? '⚠️ E no work o! Try again later abeg.'
          : '⚠️ An error occurred while initiating the message. Please try again later.';
        await ctx.replyWithMarkdown(errorMsg);
        ctx.answerCbQuery();
      }
      break;
    case 'mark_paid':
      try {
        const pendingTransactions = await db.collection('transactions').where('status', '==', 'Pending').get();
        if (pendingTransactions.empty) {
          await ctx.answerCbQuery(userState.usePidgin ? 'No pending transactions dey o.' : 'No pending transactions found.', { show_alert: true });
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
            const userStateTx = await getUserState(txData.userId);
            const successMsg = userStateTx.usePidgin
              ? `🎉 *Transaction Successful!*\n\nHello ${accountName},\n\nYour DirectPay order don complete o! Here’s the gist:\n\n*Crypto amount:* ${txData.amount} ${txData.asset}\n*Cash amount:* NGN ${payout}\n*Network:* ${txData.chain}\n*Date:* ${new Date(txData.timestamp).toLocaleString()}\n\nThank you 💙.\n\n${accountName}, you don hammer o! NGN ${payout} just land like hot amala for your plate. Others dey cry with lower rates, but you dey laugh with DirectPay—na you sabi road!`
              : `🎉 *Funds Credited Successfully!*\n\nHello ${accountName},\n\nYour DirectPay order has been completed. Here are the details:\n\n*Crypto amount:* ${txData.amount} ${txData.asset}\n*Cash amount:* NGN ${payout}\n*Network:* ${txData.chain}\n*Date:* ${new Date(txData.timestamp).toLocaleString()}\n\nThank you 💙.\n\n${accountName}, you’ve struck gold! NGN ${payout} just landed like a VIP delivery. Others are stuck with lower rates, but you’re winning with DirectPay—smart move!`;
            await bot.telegram.sendPhoto(txData.userId, { source: PAYOUT_SUCCESS_IMAGE }, { caption: successMsg, parse_mode: 'Markdown' });
            logger.info(`Notified user ${txData.userId} about paid transaction ${txData.referenceId}`);
          } catch (error) {
            logger.error(`Error notifying user ${txData.userId}: ${error.message}`);
          }
        });
        const successMsg = userState.usePidgin
          ? '✅ All pending transactions don mark as paid o!'
          : '✅ All pending transactions have been marked as paid.';
        await ctx.editMessageText(successMsg, { reply_markup: getAdminMenu() });
        ctx.answerCbQuery();
      } catch (error) {
        logger.error(`Error marking transactions as paid: ${error.message}`);
        await ctx.answerCbQuery(userState.usePidgin ? '⚠️ E no work o! Try again later.' : '⚠️ Error marking transactions as paid. Please try again later.', { show_alert: true });
      }
      break;
    case 'view_users':
      try {
        const usersSnapshot = await db.collection('users').get();
        if (usersSnapshot.empty) {
          await ctx.answerCbQuery(userState.usePidgin ? 'No users dey o.' : 'No users found.', { show_alert: true });
          return;
        }
        let message = userState.usePidgin
          ? '👥 **All Users**:\n\n'
          : '👥 **All Users**:\n\n';
        usersSnapshot.forEach((doc) => {
          const user = doc.data();
          message += `*User ID:* ${doc.id}\n*First Name:* ${user.firstName || 'N/A'}\n*Number of Wallets:* ${user.wallets.length}\n*Bank Linked:* ${user.wallets.some(wallet => wallet.bank) ? 'Yes' : 'No'}\n\n`;
        });
        const inlineKeyboard = Markup.inlineKeyboard([
          [Markup.button.callback(userState.usePidgin ? '🔙 Back to Admin Menu' : '🔙 Back to Admin Menu', 'admin_back_to_main')]
        ]);
        await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: inlineKeyboard.reply_markup });
        ctx.answerCbQuery();
      } catch (error) {
        logger.error(`Error fetching all users: ${error.message}`);
        await ctx.answerCbQuery(userState.usePidgin ? '⚠️ No fit fetch users o.' : '⚠️ Unable to fetch users.', { show_alert: true });
      }
      break;
    case 'broadcast_message':
      try {
        const usersSnapshot = await db.collection('users').get();
        if (usersSnapshot.empty) {
          const errorMsg = userState.usePidgin
            ? '⚠️ No users dey to broadcast o.'
            : '⚠️ No users available to broadcast.';
          await ctx.replyWithMarkdown(errorMsg);
          return ctx.answerCbQuery();
        }
        const prompt = userState.usePidgin
          ? '📢 Abeg enter the message you wan broadcast to all users. You fit add picture (receipt) join am:'
          : '📢 Please enter the message you want to broadcast to all users. You can also attach an image (receipt) with your message:';
        await ctx.reply(prompt);
        await ctx.answerCbQuery();
      } catch (error) {
        logger.error(`Error initiating broadcast message: ${error.message}`);
        const errorMsg = userState.usePidgin
          ? '⚠️ E no work o! Try again later abeg.'
          : '⚠️ An error occurred while initiating the broadcast. Please try again later.';
        await ctx.replyWithMarkdown(errorMsg);
        ctx.answerCbQuery();
      }
      break;
    case 'back_to_main':
      await greetUser(ctx);
      if (ctx.session.adminMessageId) {
        await ctx.deleteMessage(ctx.session.adminMessageId).catch(() => {});
        ctx.session.adminMessageId = null;
      }
      ctx.answerCbQuery();
      break;
    default:
      await ctx.answerCbQuery(userState.usePidgin ? '⚠️ Wetin be this o? Pick correct option abeg.' : '⚠️ Unknown action. Please select an option from the menu.', { show_alert: true });
  }
});

app.use(WEBHOOK_PATH, bodyParser.json());
app.post(WEBHOOK_PATH, bodyParser.json(), async (req, res) => {
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
});

app.listen(PORT, () => {
  logger.info(`Webhook server running on port ${PORT}`);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

const detailedTutorials = {
  how_it_works: {
    english: `
**📘 How DirectPay Works**

1. **Generate Your Wallet:**  
   - Navigate to the "💼 Generate Wallet" option.  
   - Your wallet supports USDC/USDT deposits on **Base, BNB Smart Chain, and Polygon**.  

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
    pidgin: `
**📘 How DirectPay Dey Work**

1. **Generate Your Wallet:**  
   - Go click "💼 Generate Wallet" option.  
   - Your wallet fit take USDC/USDT deposits for **Base, BNB Smart Chain, and Polygon**.  

2. **Link Your Bank Account:**  
   - After you generate wallet, put your bank details so we fit send payout straight to your account.  

3. **Receive Payments:**  
   - Share your wallet address with clients or people wey go pay you.  
   - Once dem deposit, DirectPay go change the crypto to NGN with current rates sharp-sharp.  

4. **Monitor Transactions:**  
   - Use "💰 Transactions" option to see all your deposit gist.  

5. **Support & Assistance:**  
   - Check support tutorials anytime from "ℹ️ Support" section.  

**🔒 Security:**  
Your money dey safe with us o. We dey use top-notch encryption and security to guard your assets and info.  

**💬 Need Help?**  
Visit the support section or ping our support team for [@maxcswap](https://t.me/maxcswap) anytime o.
`
  },
  transaction_guide: {
    english: `
**💰 Transaction Not Received?**

If you haven’t received your transaction, follow these steps to troubleshoot:

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
   - If the issue persists after following the above steps, reach out to our support team at [@maxcswap](https://t.me/maxcswap) with your transaction details for further assistance.
`,
    pidgin: `
**💰 Transaction No Show?**

If your transaction never land, follow these steps to check am:

1. **Verify Wallet Address:**  
   - Make sure say the person wey send use the correct wallet address wey DirectPay give you.  

2. **Check Bank Linking:**  
   - Confirm say your bank account dey linked well.  
   - If e no dey linked, enter "⚙️ Settings" > "🏦 Link Bank Account" to add your bank details.  

3. **Monitor Transaction Status:**  
   - Check "💰 Transactions" section to see your deposit status.  
   - If e dey "Pending," e mean say e still dey cook.  

4. **Wait Small:**  
   - Deposits fit take small time to show depending on network traffic o.  

5. **Contact Support:**  
   - If e still no work after all this, ping our support team for [@maxcswap](https://t.me/maxcswap) with your transaction gist make dem help you sharp-sharp.
`
  },
  link_bank_tutorial: {
    english: `
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
    pidgin: `
**🏦 How to Edit Your Bank Account**

*To Change Bank Account Wey Dey:*

1. **Go Edit Bank:**  
   - Click "⚙️ Settings" > "✏️ Edit Linked Bank Details" from the main menu.  

2. **Pick Wallet:**  
   - Choose the wallet wey you wan edit the bank account for.  

3. **Put New Bank Details:**  
   - Enter the new bank name or account number wey you need.  

4. **Check Am Well:**  
   - Confirm the new account holder name.  

5. **Finish:**  
   - Your bank account details don update finish o!
`
  }
};
