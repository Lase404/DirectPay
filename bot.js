const { Telegraf, Scenes, session, Markup } = require('telegraf');
const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const axios = require('axios');
const crypto = require('crypto');
const winston = require('winston');
const fs = require('fs');
const { createReadStream, unlink } = require('fs');
const { promisify } = require('util');
const unlinkAsync = promisify(unlink);
const path = require('path');
const sharp = require('sharp');
const requestIp = require('request-ip');

// =================== Initialize Logging ===================
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `[${timestamp}] ${level.toUpperCase()}: ${message}`)
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
  BOT_TOKEN: TELEGRAM_BOT_TOKEN,
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

if (!TELEGRAM_BOT_TOKEN || !PAYCREST_API_KEY || !PAYCREST_CLIENT_SECRET || !WEBHOOK_DOMAIN || !PAYSTACK_API_KEY) {
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

const WALLET_GENERATED_IMAGE = './wallet_generated_base1.png';
const DEPOSIT_SUCCESS_IMAGE = './deposit_success.png';
const PAYOUT_SUCCESS_IMAGE = './payout_success.png';
const ERROR_IMAGE = './error.png';

// =================== Initialize Express and Telegraf ===================
const app = express();
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// =================== Define Supported Banks ===================
const bankList = [
  { name: 'Access Bank', code: '044', aliases: ['access', 'access bank', 'accessb', 'access bank nigeria'], paycrestInstitutionCode: 'ACCESSNGLA' },
  { name: 'Zenith Bank', code: '057', aliases: ['zenith', 'zenith bank', 'zenithb', 'zenith bank nigeria'], paycrestInstitutionCode: 'ZENITHNGLA' },
  { name: 'First Bank', code: '011', aliases: ['first', 'first bank', 'firstb', 'first bank nigeria'], paycrestInstitutionCode: 'FIRSTNGLA' },
  { name: 'GTBank', code: '058', aliases: ['gtbank', 'gtbank nigeria', 'gtb', 'gt bank'], paycrestInstitutionCode: 'GTBNGLA' },
  { name: 'UBA', code: '033', aliases: ['uba', 'uba nigeria', 'ubab'], paycrestInstitutionCode: 'UBANGLA' },
  { name: 'Fidelity Bank', code: '070', aliases: ['fidelity', 'fidelity bank', 'fidelityb', 'fidelity bank nigeria'], paycrestInstitutionCode: 'FIDNGLA' },
  { name: 'Heritage Bank', code: '030', aliases: ['heritage', 'heritage bank', 'heritageb', 'heritage bank nigeria'], paycrestInstitutionCode: 'HERITAGENGLA' },
  { name: 'Sterling Bank', code: '232', aliases: ['sterling', 'sterling bank', 'sterlingb', 'sterling bank nigeria'], paycrestInstitutionCode: 'STERLINGNGLA' },
  { name: 'Wema Bank', code: '035', aliases: ['wema', 'wema bank', 'wemab', 'wema bank nigeria'], paycrestInstitutionCode: 'WEMANGLA' },
  { name: 'Kuda Microfinance Bank', code: '50211', aliases: ['kuda', 'kuda bank', 'kudab', 'kuda bank nigeria'], paycrestInstitutionCode: 'KUDANGPC' },
  { name: 'OPay', code: '999992', aliases: ['opay', 'opay nigeria'], paycrestInstitutionCode: 'OPAYNGPC' },
  { name: 'PalmPay', code: '999991', aliases: ['palmpay', 'palmpay nigeria'], paycrestInstitutionCode: 'PALMNGPC' },
  { name: 'Paystack-Titan MFB', code: '999992', aliases: ['paystack', 'paystack mfb', 'paystack-titan mfb'], paycrestInstitutionCode: 'PAYTNGPC' },
  { name: 'Moniepoint MFB', code: '999993', aliases: ['moniepoint', 'moniepoint mfb', 'moniepoint nigeria'], paycrestInstitutionCode: 'MONINGPC' },
  { name: 'Safe Haven MFB', code: '999994', aliases: ['safe haven', 'safe haven mfb', 'safe haven nigeria'], paycrestInstitutionCode: 'SAHVNGPC' },
];

// =================== Define Supported Chains ===================
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

function calculatePayout(asset, amount) {
  const rate = exchangeRates[asset];
  if (!rate) throw new Error(`Unsupported asset received: ${asset}`);
  return parseFloat((amount * rate).toFixed(2));
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
        language: 'en', // New: Multi-language support
        lastActive: new Date().toISOString(),
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
      language: data.language || 'en',
      lastActive: data.lastActive || new Date().toISOString(),
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
      language: 'en',
      lastActive: new Date().toISOString(),
    };
  }
}

async function updateUserState(userId, newState) {
  try {
    await db.collection('users').doc(userId).update({
      ...newState,
      lastActive: new Date().toISOString(),
    });
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

function generateReceipt(txData, lang = 'en') {
  const messages = {
    en: {
      title: '🧾 *Transaction Receipt*',
      refId: '*Reference ID:*',
      amount: '*Amount:*',
      status: '*Status:*',
      rate: '*Exchange Rate:*',
      date: '*Date:*',
      chain: '*Chain:*',
    },
    pidgin: {
      title: '🧾 *Transaction Receipt*',
      refId: '*Ref ID:*',
      amount: '*Amount:*',
      status: '*Status:*',
      rate: '*Rate:*',
      date: '*Date:*',
      chain: '*Chain:*',
    },
  };
  const msg = messages[lang] || messages.en;
  let receiptMessage = `${msg.title}\n\n`;
  receiptMessage += `${msg.refId} \`${txData.referenceId || 'N/A'}\`\n`;
  receiptMessage += `${msg.amount} ${txData.amount || 'N/A'} ${txData.asset || 'N/A'}\n`;
  receiptMessage += `${msg.status} ${txData.status || 'Pending'}\n`;
  receiptMessage += `${msg.rate} ₦${exchangeRates[txData.asset] || 'N/A'} per ${txData.asset || 'N/A'}\n`;
  receiptMessage += `${msg.date} ${txData.timestamp ? new Date(txData.timestamp).toLocaleString() : 'N/A'}\n`;
  receiptMessage += `${msg.chain} ${txData.chain || 'N/A'}\n`;
  return receiptMessage;
}

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

function levenshteinDistance(a, b) {
  const matrix = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(null));
  for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= b.length; j++) matrix[j][0] = j;
  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      const indicator = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1,
        matrix[j - 1][i] + 1,
        matrix[j - 1][i - 1] + indicator
      );
    }
  }
  return matrix[b.length][a.length];
}

function findClosestBank(input, bankList) {
  const inputLower = input.toLowerCase().trim();
  let bestMatch = null;
  let minDistance = Infinity;

  bankList.forEach((bank) => {
    bank.aliases.forEach((alias) => {
      const distance = levenshteinDistance(inputLower, alias);
      if (distance < minDistance) {
        minDistance = distance;
        bestMatch = bank;
      }
    });
  });

  return { bank: bestMatch, distance: minDistance };
}

// =================== Define Scenes ===================
const bankLinkingScene = new Scenes.WizardScene(
  'bank_linking_scene',
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const walletIndex = ctx.session.walletIndex;

    logger.info(`Entering bank_linking_scene step 1 for user ${userId}, walletIndex: ${walletIndex}`);

    if (walletIndex === undefined || walletIndex === null) {
      const userState = await getUserState(userId);
      const errorMsg = userState.usePidgin
        ? '⚠️ No wallet dey here. Click "💼 Generate Wallet" to start.'
        : '⚠️ No wallet selected for linking. Please generate a wallet first.';
      await ctx.replyWithMarkdown(errorMsg);
      return ctx.scene.leave();
    }

    ctx.session.bankData = {};
    ctx.session.bankData.step = 1;
    const userState = await getUserState(userId);
    const prompt = userState.usePidgin
      ? '🏦 Enter your bank name (e.g., GTBank, Access):'
      : '🏦 Please enter your bank name (e.g., GTBank, Access):';
    await ctx.replyWithMarkdown(prompt);
    return ctx.wizard.next();
  },
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const input = ctx.message.text.trim();
    logger.info(`User ${userId} entered bank name: ${input}`);

    const userState = await getUserState(userId);
    const { bank, distance } = findClosestBank(input, bankList);

    if (!bank || distance > 3) {
      const errorMsg = userState.usePidgin
        ? `❌ Bank name no match o. Check your spelling or try:\n\n${bankList.map(b => `• ${b.name}`).join('\n')}`
        : `❌ No matching bank found. Check your spelling or try:\n\n${bankList.map(b => `• ${b.name}`).join('\n')}`;
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }

    if (distance > 0 && distance <= 3) {
      const confirmMsg = userState.usePidgin
        ? `You mean *${bank.name}*? You type "${input}".\n\nCorrect?`
        : `Did you mean *${bank.name}*? You entered "${input}".\n\nIs this correct?`;
      ctx.session.bankData.suggestedBank = bank;
      const sentMessage = await ctx.replyWithMarkdown(confirmMsg, Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes', 'confirm_suggested_bank')],
        [Markup.button.callback('❌ No', 'retry_bank_name')]
      ]));
      ctx.session.suggestionMessageId = sentMessage.message_id;
      return;
    }

    ctx.session.bankData.bankName = bank.name;
    ctx.session.bankData.bankCode = bank.code;
    ctx.session.bankData.step = 2;

    const prompt = userState.usePidgin
      ? '🔢 Enter your 10-digit account number:'
      : '🔢 Please enter your 10-digit bank account number:';
    await ctx.replyWithMarkdown(prompt);
    return ctx.wizard.next();
  },
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const input = ctx.message.text.trim();
    logger.info(`User ${userId} entered account number: ${input}`);

    const userState = await getUserState(userId);
    if (!/^\d{10}$/.test(input)) {
      const errorMsg = userState.usePidgin
        ? '❌ Account number no correct. Enter valid 10-digit number:'
        : '❌ Invalid account number. Please enter a valid 10-digit account number:';
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }

    ctx.session.bankData.accountNumber = input;
    ctx.session.bankData.step = 3;

    const verifyingMsg = userState.usePidgin
      ? '🔄 Checking your bank details...'
      : '🔄 Verifying your bank details...';
    await ctx.replyWithMarkdown(verifyingMsg);

    try {
      const verificationResult = await verifyBankAccount(ctx.session.bankData.accountNumber, ctx.session.bankData.bankCode);

      if (!verificationResult || !verificationResult.data) {
        throw new Error('Invalid verification response.');
      }

      const accountName = verificationResult.data.account_name;
      if (!accountName) throw new Error('Unable to retrieve account name.');

      ctx.session.bankData.accountName = accountName;
      ctx.session.bankData.step = 4;

      const confirmMsg = userState.usePidgin
        ? `🏦 *Bank Account Check*\n\n` +
          `Confirm your details:\n` +
          `- *Bank Name:* ${ctx.session.bankData.bankName}\n` +
          `- *Account Number:* \`${ctx.session.bankData.accountNumber}\`\n` +
          `- *Account Holder:* ${accountName}\n\n` +
          `E correct?`
        : `🏦 *Bank Account Verification*\n\n` +
          `Please confirm your bank details:\n` +
          `- *Bank Name:* ${ctx.session.bankData.bankName}\n` +
          `- *Account Number:* \`${ctx.session.bankData.accountNumber}\`\n` +
          `- *Account Holder:* ${accountName}\n\n` +
          `Is this correct?`;
      await ctx.replyWithMarkdown(confirmMsg, Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes, Confirm', 'confirm_bank_yes')],
        [Markup.button.callback('❌ No, Edit Details', 'confirm_bank_no')],
        [Markup.button.callback('❌ Cancel Linking', 'cancel_bank_linking')],
      ]));
      return ctx.wizard.next();
    } catch (error) {
      logger.error(`Error verifying bank account for user ${userId}: ${error.message}`);
      const errorMsg = userState.usePidgin
        ? '❌ E no work. Check your details or try again later.'
        : '❌ Failed to verify your bank account. Please check your details or try again later.';
      await ctx.replyWithMarkdown(errorMsg);
      return ctx.scene.leave();
    }
  },
  async (ctx) => {
    return;
  }
);

bankLinkingScene.action('confirm_suggested_bank', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const suggestedBank = ctx.session.bankData.suggestedBank;

  ctx.session.bankData.bankName = suggestedBank.name;
  ctx.session.bankData.bankCode = suggestedBank.code;
  ctx.session.bankData.step = 2;

  const prompt = userState.usePidgin
    ? '🔢 Enter your 10-digit account number:'
    : '🔢 Please enter your 10-digit bank account number:';
  await ctx.replyWithMarkdown(prompt);
  await ctx.answerCbQuery();
  ctx.wizard.next();
});

bankLinkingScene.action('retry_bank_name', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  if (ctx.session.suggestionMessageId) {
    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, ctx.session.suggestionMessageId);
      delete ctx.session.suggestionMessageId;
    } catch (error) {
      logger.error(`Failed to delete suggestion message for user ${userId}: ${error.message}`);
    }
  }

  const prompt = userState.usePidgin
    ? '🏦 Enter the correct bank name one more time (e.g., GTBank, Access):'
    : '🏦 Please enter the correct bank name one more time (e.g., GTBank, Access):';
  await ctx.replyWithMarkdown(prompt);
  await ctx.answerCbQuery();
});

bankLinkingScene.action('confirm_bank_yes', async (ctx) => {
  const userId = ctx.from.id.toString();
  const bankData = ctx.session.bankData;
  const walletIndex = ctx.session.walletIndex;
  const tempFilePath = path.join(__dirname, `temp_qr_${userId}_${Date.now()}.png`);

  try {
    let userState = await getUserState(userId);

    if (walletIndex === undefined || walletIndex === null || !userState.wallets[walletIndex]) {
      const errorMsg = userState.usePidgin
        ? '⚠️ No wallet dey here. Click "💼 Generate Wallet" to start.'
        : '⚠️ No wallet selected for linking. Please generate a wallet first.';
      await ctx.replyWithMarkdown(errorMsg);
      await ctx.answerCbQuery();
      return ctx.scene.leave();
    }

    userState.wallets[walletIndex].bank = {
      bankName: bankData.bankName,
      bankCode: bankData.bankCode,
      accountNumber: bankData.accountNumber,
      accountName: bankData.accountName,
    };

    await updateUserState(userId, { wallets: userState.wallets });

    const walletAddress = userState.wallets[walletIndex].address;
    const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(walletAddress)}`;
    const qrCodeResponse = await axios.get(qrCodeUrl, { responseType: 'arraybuffer' });
    const qrCodeBuffer = Buffer.from(qrCodeResponse.data);

    if (!fs.existsSync(WALLET_GENERATED_IMAGE)) {
      throw new Error(`Base image not found at ${WALLET_GENERATED_IMAGE}`);
    }

    const qrCodePosition = { top: 250, left: 210 };
    await sharp(WALLET_GENERATED_IMAGE)
      .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
      .composite([{ input: qrCodeBuffer, top: qrCodePosition.top, left: qrCodePosition.left }])
      .png()
      .toFile(tempFilePath);

    const confirmationMessage = userState.usePidgin
      ? `✅ *Bank Account Linked*\n\n` +
        `*Bank Name:* ${bankData.bankName}\n` +
        `*Account Number:* \`${bankData.accountNumber}\`\n` +
        `*Account Holder:* ${bankData.accountName}\n\n` +
        `📂 *Wallet Details:*\n` +
        `• *Chain:* ${userState.wallets[walletIndex].chain}\n` +
        `• *Address:* \`${walletAddress}\`\n\n` +
        `You fit start receive payouts now.`
      : `✅ *Bank Account Linked*\n\n` +
        `*Bank Name:* ${bankData.bankName}\n` +
        `*Account Number:* \`${bankData.accountNumber}\`\n` +
        `*Account Holder:* ${bankData.accountName}\n\n` +
        `📂 *Wallet Details:*\n` +
        `• *Chain:* ${userState.wallets[walletIndex].chain}\n` +
        `• *Address:* \`${walletAddress}\`\n\n` +
        `You can now receive payouts.`;

    await ctx.replyWithPhoto({ source: createReadStream(tempFilePath) }, {
      caption: confirmationMessage,
      parse_mode: 'Markdown',
    });

    await unlinkAsync(tempFilePath);

    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🔗 User ${userId} linked a bank account:\n\n*Account Name:* ${bankData.accountName}\n*Bank Name:* ${bankData.bankName}\n*Account Number:* ****${bankData.accountNumber.slice(-4)}`, { parse_mode: 'Markdown' });
    logger.info(`User ${userId} linked a bank account: ${JSON.stringify(userState.wallets[walletIndex].bank)}`);

    await ctx.answerCbQuery();
    ctx.scene.leave();
  } catch (error) {
    logger.error(`Error in confirm_bank_yes handler for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem linking bank. Try again later or contact [@maxcswap](https://t.me/maxcswap).'
      : '❌ Error confirming bank details. Try again later or contact [@maxcswap](https://t.me/maxcswap).';
    await ctx.replyWithMarkdown(errorMsg);

    if (fs.existsSync(tempFilePath)) {
      try {
        await unlinkAsync(tempFilePath);
      } catch (cleanupError) {
        logger.error(`Failed to clean up temp file ${tempFilePath}: ${cleanupError.message}`);
      }
    }

    await ctx.answerCbQuery();
    ctx.scene.leave();
  }
});

bankLinkingScene.action('confirm_bank_no', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const errorMsg = userState.usePidgin
    ? '⚠️ Let’s try again.'
    : '⚠️ Let\'s try again.';
  await ctx.replyWithMarkdown(errorMsg);
  ctx.session.bankData = {};
  await ctx.scene.enter('bank_linking_scene');
  await ctx.answerCbQuery();
});

bankLinkingScene.action('cancel_bank_linking', async (ctx) => {
  const userState = await getUserState(ctx.from.id.toString());
  const errorMsg = userState.usePidgin
    ? '❌ Bank linking cancelled.'
    : '❌ Bank linking process cancelled.';
  await ctx.replyWithMarkdown(errorMsg);
  delete ctx.session.walletIndex;
  delete ctx.session.bankData;
  await ctx.answerCbQuery();
  ctx.scene.leave();
});

const sendMessageScene = new Scenes.WizardScene(
  'send_message_scene',
  async (ctx) => {
    await ctx.replyWithMarkdown('📩 Please enter the User ID you want to message:');
    return ctx.wizard.next();
  },
  async (ctx) => {
    const userIdToMessage = ctx.message.text.trim();
    const userState = await getUserState(ctx.from.id.toString());

    if (!/^\d{5,15}$/.test(userIdToMessage)) {
      const errorMsg = userState.usePidgin
        ? '❌ User ID no correct. Enter valid number (5-15 digits).'
        : '❌ Invalid User ID. Please enter a valid numeric User ID (5-15 digits):';
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }

    const userDoc = await db.collection('users').doc(userIdToMessage).get();
    if (!userDoc.exists) {
      const errorMsg = userState.usePidgin
        ? '❌ User ID no dey. Check am well.'
        : '❌ User ID not found. Please ensure the User ID is correct.';
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }

    ctx.session.userIdToMessage = userIdToMessage;
    const prompt = userState.usePidgin
      ? '📝 Enter message for user or send receipt pic:'
      : '📝 Please enter the message or attach an image (receipt) for the user:';
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
          ? '✅ Pic message don send.'
          : '✅ Photo message sent successfully.';
        await ctx.replyWithMarkdown(successMsg);
        logger.info(`Admin ${adminUserId} sent photo message to user ${userIdToMessage}. Caption: ${caption}`);
      } catch (error) {
        logger.error(`Error sending photo to user ${userIdToMessage}: ${error.message}`);
        const errorMsg = userState.usePidgin
          ? '❌ Error sending pic. Check User ID or try again.'
          : '❌ Error sending photo. Ensure the User ID is correct.';
        await ctx.replyWithMarkdown(errorMsg);
      }
    } else if (ctx.message.text) {
      const messageContent = ctx.message.text.trim();
      if (!messageContent) {
        const errorMsg = userState.usePidgin
          ? '❌ Message no fit empty. Enter something.'
          : '❌ Message content cannot be empty. Please enter a message:';
        await ctx.replyWithMarkdown(errorMsg);
        return;
      }

      try {
        await bot.telegram.sendMessage(userIdToMessage, `📩 *Message from Admin:*\n\n${messageContent}`, { parse_mode: 'Markdown' });
        const successMsg = userState.usePidgin
          ? '✅ Text message don send.'
          : '✅ Text message sent successfully.';
        await ctx.replyWithMarkdown(successMsg);
        logger.info(`Admin ${adminUserId} sent text message to user ${userIdToMessage}: ${messageContent}`);
      } catch (error) {
        logger.error(`Error sending message to user ${userIdToMessage}: ${error.message}`);
        const errorMsg = userState.usePidgin
          ? '❌ Error sending message. Check User ID or try again.'
          : '❌ Error sending message. Ensure the User ID is correct.';
        await ctx.replyWithMarkdown(errorMsg);
      }
    } else {
      const errorMsg = userState.usePidgin
        ? '❌ Send text or pic abeg.'
        : '❌ Please send text or a photo.';
      await ctx.replyWithMarkdown(errorMsg);
    }

    delete ctx.session.userIdToMessage;
    ctx.scene.leave();
  }
);

const receiptGenerationScene = new Scenes.WizardScene(
  'receipt_generation_scene',
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const userState = await getUserState(userId);

    if (userState.wallets.length === 0) {
      const errorMsg = userState.usePidgin
        ? '❌ No wallet dey. Click "💼 Generate Wallet" to start.'
        : '❌ You have no wallets. Generate one first with "💼 Generate Wallet".';
      await ctx.replyWithMarkdown(errorMsg);
      return ctx.scene.leave();
    }

    if (userState.wallets.length === 1) {
      ctx.session.walletIndex = 0;
      return ctx.wizard.next();
    }

    let keyboard = userState.wallets.map((wallet, index) => [
      Markup.button.callback(`Wallet ${index + 1} - ${wallet.chain}`, `select_receipt_wallet_${index}`)
    ]);
    const prompt = userState.usePidgin
      ? 'Pick wallet for receipt:'
      : 'Select wallet for receipt:';
    await ctx.reply(prompt, Markup.inlineKeyboard(keyboard));
    return ctx.wizard.next();
  },
  async (ctx) => {
    const userId = ctx.from.id.toString();
    let walletIndex;

    if (ctx.session.walletIndex === undefined || ctx.session.walletIndex === null) {
      const match = ctx.match ? ctx.match[1] : null;
      walletIndex = match ? parseInt(match, 10) : null;

      if (!walletIndex && walletIndex !== 0) {
        const userState = await getUserState(userId);
        const errorMsg = userState.usePidgin
          ? '⚠️ Wallet no correct. Try again.'
          : '⚠️ Invalid wallet selection. Please try again.';
        await ctx.replyWithMarkdown(errorMsg);
        return ctx.wizard.back();
      }
      ctx.session.walletIndex = walletIndex;
    } else {
      walletIndex = ctx.session.walletIndex;
    }

    try {
      const userState = await getUserState(userId);
      const wallet = userState.wallets[walletIndex];

      if (!wallet) throw new Error('Wallet not found.');

      const transactionsSnapshot = await db.collection('transactions')
        .where('walletAddress', '==', wallet.address)
        .orderBy('timestamp', 'desc')
        .limit(10)
        .get();

      if (transactionsSnapshot.empty) {
        const noTxMsg = userState.usePidgin
          ? 'No transactions for this wallet yet.'
          : 'No transactions found for this wallet yet.';
        return ctx.replyWithMarkdown(noTxMsg);
      }

      let receiptMessage = userState.usePidgin
        ? `🧾 *Receipt for Wallet ${walletIndex + 1} - ${wallet.chain}*\n\n`
        : `🧾 *Transaction Receipt for Wallet ${walletIndex + 1} - ${wallet.chain}*\n\n`;
      transactionsSnapshot.forEach((doc) => {
        const tx = doc.data();
        receiptMessage += `*Transaction ${tx.referenceId || 'N/A'}:*\n`;
        receiptMessage += `• *Ref ID:* \`${tx.referenceId || 'N/A'}\`\n`;
        receiptMessage += `• *Amount:* ${tx.amount || 'N/A'} ${tx.asset || 'N/A'}\n`;
        receiptMessage += `• *Status:* ${tx.status || 'Pending'}\n`;
        receiptMessage += `• *Rate:* ₦${exchangeRates[tx.asset] || 'N/A'} per ${tx.asset || 'N/A'}\n`;
        receiptMessage += `• *Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n`;
        receiptMessage += `• *Chain:* ${tx.chain || 'N/A'}\n\n`;
      });

      const exportMsg = userState.usePidgin
        ? '📥 Click to export receipt as text or PDF:'
        : '📥 Click to export this receipt as text or PDF:';
      await ctx.replyWithMarkdown(receiptMessage + exportMsg, Markup.inlineKeyboard([
        [Markup.button.callback('📤 Export Text', `export_receipt_text_${walletIndex}`)],
        [Markup.button.callback('📜 Export PDF', `export_receipt_pdf_${walletIndex}`)]
      ]));
      ctx.scene.leave();
    } catch (error) {
      logger.error(`Error generating receipt for user ${userId}: ${error.message}`);
      const userState = await getUserState(userId);
      const errorMsg = userState.usePidgin
        ? '❌ Error making receipt. Try again later.'
        : '❌ An error occurred while generating the receipt. Try again later.';
      await ctx.replyWithMarkdown(errorMsg);
      ctx.scene.leave();
    }
  }
);

// New: Language Selection Scene
const languageSelectionScene = new Scenes.WizardScene(
  'language_selection_scene',
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const userState = await getUserState(userId);
    const prompt = userState.usePidgin
      ? '🌍 Pick your language:'
      : '🌍 Select your preferred language:';
    await ctx.replyWithMarkdown(prompt, Markup.inlineKeyboard([
      [Markup.button.callback('🇬🇧 English', 'lang_en')],
      [Markup.button.callback('🇳🇬 Pidgin', 'lang_pidgin')],
      [Markup.button.callback('🇫🇷 French', 'lang_fr')]
    ]));
    return ctx.wizard.next();
  },
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const userState = await getUserState(userId);
    const lang = ctx.match ? ctx.match[1] : null;

    if (!lang) {
      const errorMsg = userState.usePidgin
        ? '❌ Pick one language abeg.'
        : '❌ Please select a language.';
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }

    let langCode, usePidgin;
    switch (lang) {
      case 'en':
        langCode = 'en';
        usePidgin = false;
        break;
      case 'pidgin':
        langCode = 'en';
        usePidgin = true;
        break;
      case 'fr':
        langCode = 'fr';
        usePidgin = false;
        break;
      default:
        await ctx.replyWithMarkdown(userState.usePidgin ? '❌ Language no dey yet.' : '❌ Language not supported yet.');
        return ctx.scene.leave();
    }

    await updateUserState(userId, { language: langCode, usePidgin });
    const successMsg = usePidgin
      ? `✅ Language don change to ${lang === 'pidgin' ? 'Pidgin' : lang === 'en' ? 'English' : 'French'}!`
      : `✅ Language set to ${lang === 'pidgin' ? 'Pidgin' : lang === 'en' ? 'English' : 'French'}!`;
    await ctx.replyWithMarkdown(successMsg);
    await greetUser(ctx);
    ctx.scene.leave();
  }
);

// =================== Register Scenes with Stage ===================
const stage = new Scenes.Stage();
stage.register(bankLinkingScene, sendMessageScene, receiptGenerationScene, languageSelectionScene);
bot.use(session());
bot.use(stage.middleware());

// =================== Apply Telegraf Webhook Middleware ===================
if (WEBHOOK_DOMAIN && WEBHOOK_PATH) {
  const webhookURL = `${WEBHOOK_DOMAIN}${WEBHOOK_PATH}`;
  bot.telegram.setWebhook(webhookURL)
    .then(() => logger.info(`Webhook set to ${webhookURL}`))
    .catch((err) => logger.error(`Failed to set webhook: ${err.message}`));
  app.use(bot.webhookCallback(WEBHOOK_PATH));
} else {
  logger.warn('WEBHOOK_DOMAIN or WEBHOOK_PATH not set. Falling back to long polling.');
  bot.launch().then(() => logger.info('Bot started using long polling.')).catch((err) => logger.error(`Failed to launch bot: ${err.message}`));
}

// =================== Apply Other Middlewares ===================
app.use(bodyParser.json());
app.use(bodyParser.raw({ type: 'application/json' }));
app.use(requestIp.mw());

// =================== Exchange Rate Fetching ===================
const SUPPORTED_ASSETS = ['USDC', 'USDT'];
let exchangeRates = { USDC: 0, USDT: 0 };

async function fetchExchangeRate(asset) {
  try {
    const response = await axios.get(`${PAYCREST_RATE_API_URL}`, {
      headers: { 'Authorization': `Bearer ${PAYCREST_API_KEY}`, 'Content-Type': 'application/json' },
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
const getMainMenu = (walletExists, hasBankLinked) =>
  Markup.keyboard([
    [walletExists ? '💼 View Wallet' : '💼 Generate Wallet', '⚙️ Settings'],
    ['💰 Transactions', 'ℹ️ Support', '📘 Learn About Base'],
    ['📈 View Current Rates'],
  ]).resize();

const getSettingsMenu = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Generate New Wallet', 'settings_generate_wallet')],
    [Markup.button.callback('✏️ Edit Bank Details', 'settings_edit_bank')],
    [Markup.button.callback('📝 Rename Wallet', 'settings_rename_wallet')],
    [Markup.button.callback('🌍 Change Language', 'settings_language')], // New: Language option
    [Markup.button.callback('💬 Support', 'settings_support')],
    [Markup.button.callback('🔙 Back to Main Menu', 'settings_back_main')],
  ]);

const getAdminMenu = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('📋 All Transactions', 'admin_view_all_transactions')],
    [Markup.button.callback('👥 All Users', 'admin_view_users')],
    [Markup.button.callback('⏳ Pending Issues', 'admin_pending_issues')],
    [Markup.button.callback('📨 Send User Message', 'admin_send_message')],
    [Markup.button.callback('💰 Manual Payout', 'admin_manual_payout')],
    [Markup.button.callback('🔄 Refund Transaction', 'admin_refund_tx')],
    [Markup.button.callback('📊 Analytics', 'admin_analytics')], // New: Admin analytics
    [Markup.button.callback('⚠️ API/Bot Status', 'admin_api_status')],
    [Markup.button.callback('🔙 Back to Main Menu', 'admin_back_to_main')],
  ]);

// =================== Check if User is Admin ===================
const isAdmin = (userId) => ADMIN_IDS.split(',').map(id => id.trim()).includes(userId.toString());

// =================== /start Command ===================
bot.start(async (ctx) => {
  try {
    await greetUser(ctx);
  } catch (error) {
    logger.error(`Error in /start command: ${error.message}`);
    await ctx.replyWithMarkdown('❌ Something went wrong. Try again later.');
  }
});

async function greetUser(ctx) {
  const userId = ctx.from.id.toString();
  let userState;
  try {
    userState = await getUserState(userId);

    if (!userState.firstName && ctx.from.first_name) {
      await updateUserState(userId, { firstName: ctx.from.first_name || 'Valued User' });
      userState.firstName = ctx.from.first_name || 'Valued User';
    }
  } catch (error) {
    logger.error(`Error fetching user state for ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('❌ Error starting. Try again later.');
    return;
  }

  const walletExists = userState.wallets.length > 0;
  const hasBankLinked = userState.wallets.some(wallet => wallet.bank);
  const adminUser = isAdmin(userId);

  const greeting = walletExists
    ? userState.usePidgin
      ? `👋 Welcome back, ${userState.firstName}!\n\nThis na **DirectPay**, your crypto-to-cash plug.\n\n💡 *How to Start:*\n1. Link bank with "⚙️ Settings"\n2. Check your wallet address\n3. Send stablecoins, get cash fast.\n\nRates dey fresh, money dey safe!`
      : `👋 Welcome back, ${userState.firstName}!\n\nThis is **DirectPay**, your crypto-to-cash solution.\n\n💡 *Quick Start:*\n1. Link your bank in "⚙️ Settings"\n2. View your wallet address\n3. Send stablecoins, receive cash quickly.\n\nRates are updated, funds are secure!`
    : userState.usePidgin
      ? `👋 Hello, ${userState.firstName}!\n\nWelcome to **DirectPay**. Let’s start your crypto journey. Use the menu below.`
      : `👋 Hello, ${userState.firstName}!\n\nWelcome to **DirectPay**. Let’s begin your crypto journey. Use the menu below.`;

  if (adminUser) {
    try {
      const sentMessage = await ctx.replyWithMarkdown(greeting, Markup.inlineKeyboard([
        [Markup.button.callback('🔧 Admin Panel', 'open_admin_panel')],
      ]));
      ctx.session.adminMessageId = sentMessage.message_id;
    } catch (error) {
      logger.error(`Error sending admin greeting to user ${userId}: ${error.message}`);
      await ctx.replyWithMarkdown('❌ Error sending greeting. Try again later.');
    }
  } else {
    await ctx.replyWithMarkdown(greeting, getMainMenu(walletExists, hasBankLinked));
  }
}

// =================== Generate Wallet Handler ===================
bot.hears('💼 Generate Wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  const ip = ctx.requestIp || 'Unknown';
  let suggestPidgin = ip.startsWith('41.') || ip.startsWith('197.') || ip.startsWith('105.');

  try {
    const userState = await getUserState(userId);
    
    if (userState.wallets.length >= MAX_WALLETS) {
      const errorMsg = userState.usePidgin
        ? `⚠️ You don reach max wallets (${MAX_WALLETS}). Check your wallets first.`
        : `⚠️ You’ve reached the max wallet limit (${MAX_WALLETS}). Check your existing wallets first.`;
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }
    
    let ratesMessage = userState.usePidgin
      ? '📈 *Current Rates*\n\n'
      : '📈 *Current Exchange Rates*\n\n';
    for (const [asset, rate] of Object.entries(exchangeRates)) {
      ratesMessage += `• *${asset}*: ₦${rate}\n`;
    }
    ratesMessage += userState.usePidgin
      ? `\nThese rates go work for your deposits and payouts.`
      : `\nThese rates apply to your deposits and payouts.`;
    await ctx.replyWithMarkdown(ratesMessage);

    const chain = 'Base';
    const generatingMessage = await ctx.replyWithMarkdown(userState.usePidgin
      ? `🔄 Generating wallet for ${chain}. Wait small...`
      : `🔄 Generating your wallet on ${chain}. Please wait...`);

    try {
      const walletAddress = await generateWallet(chain);
      userState.wallets.push({
        address: walletAddress,
        chain: chain,
        supportedAssets: chains[chain].supportedAssets,
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

      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `💼 Wallet generated for user ${userId} on ${chain}: ${walletAddress}`, { parse_mode: 'Markdown' });
      logger.info(`Wallet generated for user ${userId} on ${chain}: ${walletAddress}`);

      const newWalletIndex = userState.wallets.length - 1;
      ctx.session.walletIndex = newWalletIndex;

      await ctx.deleteMessage(generatingMessage.message_id);

      const successMsg = userState.usePidgin
        ? `✅ *Wallet Ready*\n\n` +
          `*Networks:* Base, BNB Smart Chain, Polygon (EVM Compatible)\n` +
          `*Assets:* USDC, USDT\n` +
          `*Address:* \`${walletAddress}\`\n\n` +
          `Let’s link your bank now to start using it.`
        : `✅ *Wallet Generated*\n\n` +
          `*Networks:* Base, BNB Smart Chain, Polygon (EVM Compatible)\n` +
          `*Assets:* USDC, USDT\n` +
          `*Address:* \`${walletAddress}\`\n\n` +
          `Let’s link your bank now to start using it.`;
      await ctx.replyWithMarkdown(successMsg, { reply_markup: getMainMenu(true, false) });

      if (suggestPidgin && !userState.usePidgin) {
        await ctx.replyWithMarkdown('👋 You dey Nigeria? Type "Pidgin" to switch if you like.');
      }

      await ctx.scene.enter('bank_linking_scene');
    } catch (error) {
      logger.error(`Error generating wallet for user ${userId} on ${chain}: ${error.message}`);
      const errorMsg = userState.usePidgin
        ? '❌ Problem dey. Try again later.'
        : '❌ Something went wrong. Please try again later.';
      await ctx.replyWithMarkdown(errorMsg);
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error generating wallet for user ${userId}: ${error.message}`, { parse_mode: 'Markdown' });
    }
  } catch (error) {
    logger.error(`Error handling Generate Wallet for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ E no work. Try again later.'
      : '❌ It didn’t work. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
  }
});

// =================== View Wallet Handler ===================
bot.hears('💼 View Wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  const ip = ctx.requestIp || 'Unknown';
  let suggestPidgin = ip.startsWith('41.') || ip.startsWith('197.') || ip.startsWith('105.');

  try {
    const userState = await getUserState(userId);
    
    if (userState.wallets.length === 0) {
      const errorMsg = userState.usePidgin
        ? '❌ No wallet dey. Click "💼 Generate Wallet" to start.'
        : '❌ You have no wallets. Generate one with "💼 Generate Wallet".';
      await ctx.replyWithMarkdown(errorMsg);
      if (suggestPidgin && !userState.usePidgin) {
        await ctx.replyWithMarkdown('👋 You dey Nigeria? Type "Pidgin" to switch if you like.');
      }
      return;
    }

    const pageSize = 3;
    const totalPages = Math.max(1, Math.ceil(userState.wallets.length / pageSize));
    ctx.session.walletsPage = ctx.session.walletsPage || 1;

    const generateWalletPage = async (page) => {
      const start = (page - 1) * pageSize;
      const end = Math.min(start + pageSize, userState.wallets.length);
      const wallets = userState.wallets.slice(start, end).sort((a, b) => new Date(b.creationDate) - new Date(a.creationDate));

      const timestamp = new Date().toISOString();
      let message = userState.usePidgin
        ? `💼 *Your Wallets* (Page ${page}/${totalPages})\n*Updated:* ${timestamp}\n\n`
        : `💼 *Your Wallets* (Page ${page}/${totalPages})\n*Updated:* ${timestamp}\n\n`;
      wallets.forEach((wallet, index) => {
        const walletNumber = start + index + 1;
        message += userState.usePidgin
          ? `*Wallet ${walletNumber} (${wallet.name || 'Unnamed'}):*\n` +
            `• *Address:* \`${wallet.address}\`\n` +
            `• *Chain:* ${wallet.chain}\n` +
            `• *Created:* ${new Date(wallet.creationDate).toLocaleDateString()}\n` +
            `• *Bank:* ${wallet.bank ? `${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)})` : 'Not Linked'}\n\n`
          : `*Wallet ${walletNumber} (${wallet.name || 'Unnamed'}):*\n` +
            `• *Address:* \`${wallet.address}\`\n` +
            `• *Chain:* ${wallet.chain}\n` +
            `• *Created:* ${new Date(wallet.creationDate).toLocaleDateString()}\n` +
            `• *Bank Linked:* ${wallet.bank ? `${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)})` : 'Not Linked'}\n\n`;
      });

      if (wallets.length === 0) {
        message += userState.usePidgin ? 'No wallets on this page yet.' : 'No wallets on this page yet.';
      }

      const navigationButtons = [];
      if (page > 1) navigationButtons.push(Markup.button.callback('⬅️ Previous', `wallet_page_${page - 1}`));
      if (page < totalPages) navigationButtons.push(Markup.button.callback('Next ➡️', `wallet_page_${page + 1}`));
      navigationButtons.push(Markup.button.callback('🔄 Refresh', `wallet_page_${page}`));

      return { message, inlineKeyboard: Markup.inlineKeyboard([navigationButtons]) };
    };

    const { message, inlineKeyboard } = await generateWalletPage(ctx.session.walletsPage);
    const sentMessage = await ctx.replyWithMarkdown(message, inlineKeyboard);
    ctx.session.walletMessageId = sentMessage.message_id;
    if (suggestPidgin && !userState.usePidgin) {
      await ctx.replyWithMarkdown('👋 You dey Nigeria? Type "Pidgin" to switch if you like.');
    }
  } catch (error) {
    logger.error(`Error handling View Wallet for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ E no work. Try again later.'
      : '❌ Error fetching wallets. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
  }
});

bot.action(/wallet_page_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const requestedPage = parseInt(ctx.match[1], 10);

  try {
    const userState = await getUserState(userId);
    const pageSize = 3;
    const totalPages = Math.max(1, Math.ceil(userState.wallets.length / pageSize));

    if (requestedPage < 1 || requestedPage > totalPages) {
      await ctx.answerCbQuery(userState.usePidgin ? '⚠️ Page no dey.' : '⚠️ Page not found.', { show_alert: true });
      return;
    }

    ctx.session.walletsPage = requestedPage;

    const generateWalletPage = async (page) => {
      const start = (page - 1) * pageSize;
      const end = Math.min(start + pageSize, userState.wallets.length);
      const wallets = userState.wallets.slice(start, end).sort((a, b) => new Date(b.creationDate) - new Date(a.creationDate));

      const timestamp = new Date().toISOString();
      let message = userState.usePidgin
        ? `💼 *Your Wallets* (Page ${page}/${totalPages})\n*Updated:* ${timestamp}\n\n`
        : `💼 *Your Wallets* (Page ${page}/${totalPages})\n*Updated:* ${timestamp}\n\n`;
      wallets.forEach((wallet, index) => {
        const walletNumber = start + index + 1;
        message += userState.usePidgin
          ? `*Wallet ${walletNumber} (${wallet.name || 'Unnamed'}):*\n` +
            `• *Address:* \`${wallet.address}\`\n` +
            `• *Chain:* ${wallet.chain}\n` +
            `• *Created:* ${new Date(wallet.creationDate).toLocaleDateString()}\n` +
            `• *Bank:* ${wallet.bank ? `${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)})` : 'Not Linked'}\n\n`
          : `*Wallet ${walletNumber} (${wallet.name || 'Unnamed'}):*\n` +
            `• *Address:* \`${wallet.address}\`\n` +
            `• *Chain:* ${wallet.chain}\n` +
            `• *Created:* ${new Date(wallet.creationDate).toLocaleDateString()}\n` +
            `• *Bank Linked:* ${wallet.bank ? `${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)})` : 'Not Linked'}\n\n`;
      });

      if (wallets.length === 0) {
        message += userState.usePidgin ? 'No wallets on this page yet.' : 'No wallets on this page yet.';
      }

      const navigationButtons = [];
      if (page > 1) navigationButtons.push(Markup.button.callback('⬅️ Previous', `wallet_page_${page - 1}`));
      if (page < totalPages) navigationButtons.push(Markup.button.callback('Next ➡️', `wallet_page_${page + 1}`));
      navigationButtons.push(Markup.button.callback('🔄 Refresh', `wallet_page_${page}`));

      return { message, inlineKeyboard: Markup.inlineKeyboard([navigationButtons]) };
    };

    const { message, inlineKeyboard } = await generateWalletPage(requestedPage);
    if (ctx.session.walletMessageId) {
      await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.walletMessageId, null, message, {
        parse_mode: 'Markdown',
        reply_markup: inlineKeyboard.reply_markup
      });
    } else {
      const sentMessage = await ctx.replyWithMarkdown(message, inlineKeyboard);
      ctx.session.walletMessageId = sentMessage.message_id;
    }
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error navigating wallet pages for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Error turning page. Try again later.'
      : '❌ Error navigating wallets. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    ctx.answerCbQuery();
  }
});

// =================== Transactions Handler ===================
bot.hears(/💰\s*Transactions/i, async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);

    if (userState.wallets.length === 0) {
      const errorMsg = userState.usePidgin
        ? '❌ No wallet dey, so no transactions yet.'
        : '❌ No wallets yet, so no transactions.';
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }

    const initialPrompt = userState.usePidgin
      ? '💰 *Transactions*\n\nPick how you want see them:'
      : '💰 *Transactions*\n\nChoose how to view your transactions:';

    const inlineKeyboard = Markup.inlineKeyboard([
      [Markup.button.callback('📋 All Transactions', 'tx_all')],
      [Markup.button.callback('✅ Completed', 'tx_status_Completed')],
      [Markup.button.callback('❌ Failed', 'tx_status_Failed')],
      [Markup.button.callback('⏳ Pending', 'tx_status_Pending')],
      [Markup.button.callback('🔄 Refunded', 'tx_status_Refunded')],
      [Markup.button.callback('🪙 Filter by Asset', 'tx_filter_asset')],
      [Markup.button.callback('📅 Filter by Date', 'tx_filter_date')]
    ]);

    await ctx.replyWithMarkdown(initialPrompt, inlineKeyboard);
  } catch (error) {
    logger.error(`Error initiating transactions for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Error occurred. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
  }
});

async function displayTransactions(ctx, query, page = 1, filterDescription = '') {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const pageSize = 5;

  const transactionsSnapshot = await query
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .get();

  const totalDocsSnapshot = await query.count().get();
  const totalDocs = totalDocsSnapshot.data().count;
  const totalPages = Math.ceil(totalDocs / pageSize);

  const timestamp = new Date().toISOString();
  let message = userState.usePidgin
    ? `💰 *Transactions*${filterDescription} (Page ${page}/${totalPages})\n*Updated:* ${timestamp}\n\n`
    : `💰 *Transactions*${filterDescription} (Page ${page}/${totalPages})\n*Updated:* ${timestamp}\n\n`;

  if (transactionsSnapshot.empty) {
    message += userState.usePidgin ? 'No transactions here yet.' : 'No transactions found yet.';
  } else {
    transactionsSnapshot.forEach((doc) => {
      const tx = doc.data();
      message += userState.usePidgin
        ? `*Ref ID:* \`${tx.referenceId || 'N/A'}\`\n` +
          `• *Asset:* ${tx.asset || 'N/A'}\n` +
          `• *Amount:* ${tx.amount || 'N/A'}\n` +
          `• *Payout:* ₦${tx.payout || 'N/A'}\n` +
          `• *Status:* ${tx.status || 'Pending'}\n` +
          `• *Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleDateString() : 'N/A'}\n` +
          `• *Chain:* ${tx.chain || 'N/A'}\n` +
          (tx.status === 'Completed'
            ? `• *Tx Hash:* \`${tx.transactionHash || 'N/A'}\`\n` +
              `• *Paid To:* ${tx.bankDetails?.bankName || 'N/A'} (****${tx.bankDetails?.accountNumber?.slice(-4) || 'N/A'})\n` +
              `• *Receiver:* ${tx.bankDetails?.accountName || 'N/A'}\n`
            : tx.status === 'Refunded'
            ? `• *Refunded To:* \`${tx.refundAddress || tx.walletAddress || 'N/A'}\`\n`
            : '') +
          `\n`
        : `*Reference ID:* \`${tx.referenceId || 'N/A'}\`\n` +
          `• *Asset:* ${tx.asset || 'N/A'}\n` +
          `• *Amount:* ${tx.amount || 'N/A'}\n` +
          `• *Payout:* ₦${tx.payout || 'N/A'}\n` +
          `• *Status:* ${tx.status || 'Pending'}\n` +
          `• *Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleDateString() : 'N/A'}\n` +
          `• *Chain:* ${tx.chain || 'N/A'}\n` +
          (tx.status === 'Completed'
            ? `• *Transaction Hash:* \`${tx.transactionHash || 'N/A'}\`\n` +
              `• *Paid To:* ${tx.bankDetails?.bankName || 'N/A'} (****${tx.bankDetails?.accountNumber?.slice(-4) || 'N/A'})\n` +
              `• *Receiver:* ${tx.bankDetails?.accountName || 'N/A'}\n`
            : tx.status === 'Refunded'
            ? `• *Refunded To:* \`${tx.refundAddress || tx.walletAddress || 'N/A'}\`\n`
            : '') +
          `\n`;
    });
  }

  const navigationButtons = [];
  if (page > 1) navigationButtons.push(Markup.button.callback('⬅️ Previous', `tx_page_${page - 1}_${filterDescription.replace(/\s/g, '_')}`));
  if (page < totalPages) navigationButtons.push(Markup.button.callback('Next ➡️', `tx_page_${page + 1}_${filterDescription.replace(/\s/g, '_')}`));
  navigationButtons.push(Markup.button.callback('🔄 Refresh', `tx_page_${page}_${filterDescription.replace(/\s/g, '_')}`));
  navigationButtons.push(Markup.button.callback('🔙 Back to Filters', 'tx_back'));

  const inlineKeyboard = Markup.inlineKeyboard([navigationButtons]);
  await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: inlineKeyboard.reply_markup });
}

// =================== Transaction Action Handlers ===================
bot.action('tx_all', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const query = db.collection('transactions')
      .where('userId','==', userId)
      .orderBy('timestamp', 'desc');
    await displayTransactions(ctx, query, 1, ' - All');
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error fetching all transactions for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey fetching transactions. Try again later.'
      : '❌ Error fetching transactions. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    ctx.answerCbQuery();
  }
});

bot.action(/tx_status_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const status = ctx.match[1];
  try {
    const query = db.collection('transactions')
      .where('userId', '==', userId)
      .where('status', '==', status)
      .orderBy('timestamp', 'desc');
    await displayTransactions(ctx, query, 1, ` - ${status}`);
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error fetching ${status} transactions for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? `❌ Problem dey fetching ${status} transactions. Try again later.`
      : `❌ Error fetching ${status} transactions. Try again later.`;
    await ctx.replyWithMarkdown(errorMsg);
    ctx.answerCbQuery();
  }
});

bot.action('tx_filter_asset', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const prompt = userState.usePidgin
    ? '🪙 Pick asset to filter transactions:'
    : '🪙 Select asset to filter transactions:';
  await ctx.replyWithMarkdown(prompt, Markup.inlineKeyboard([
    [Markup.button.callback('USDC', 'tx_asset_USDC')],
    [Markup.button.callback('USDT', 'tx_asset_USDT')],
    [Markup.button.callback('🔙 Back', 'tx_back')]
  ]));
  ctx.answerCbQuery();
});

bot.action(/tx_asset_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const asset = ctx.match[1];
  try {
    const query = db.collection('transactions')
      .where('userId', '==', userId)
      .where('asset', '==', asset)
      .orderBy('timestamp', 'desc');
    await displayTransactions(ctx, query, 1, ` - ${asset}`);
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error fetching ${asset} transactions for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? `❌ Problem dey fetching ${asset} transactions. Try again later.`
      : `❌ Error fetching ${asset} transactions. Try again later.`;
    await ctx.replyWithMarkdown(errorMsg);
    ctx.answerCbQuery();
  }
});

bot.action('tx_filter_date', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const prompt = userState.usePidgin
    ? '📅 Enter date range (e.g., "2023-01-01 to 2023-01-31") or pick one:'
    : '📅 Enter date range (e.g., "2023-01-01 to 2023-01-31") or select an option:';
  await ctx.replyWithMarkdown(prompt, Markup.inlineKeyboard([
    [Markup.button.callback('Last 7 Days', 'tx_date_7days')],
    [Markup.button.callback('Last 30 Days', 'tx_date_30days')],
    [Markup.button.callback('Custom Range', 'tx_date_custom')],
    [Markup.button.callback('🔙 Back', 'tx_back')]
  ]));
  ctx.answerCbQuery();
});

bot.action(/tx_date_(\w+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const range = ctx.match[1];
  try {
    const userState = await getUserState(userId);
    let startDate, endDate = new Date();

    if (range === '7days') {
      startDate = new Date();
      startDate.setDate(endDate.getDate() - 7);
    } else if (range === '30days') {
      startDate = new Date();
      startDate.setDate(endDate.getDate() - 30);
    } else if (range === 'custom') {
      const prompt = userState.usePidgin
        ? '📅 Type your custom date range like "2023-01-01 to 2023-01-31":'
        : '📅 Enter your custom date range like "2023-01-01 to 2023-01-31":';
      await ctx.replyWithMarkdown(prompt);
      ctx.session.awaitingCustomDate = true;
      ctx.answerCbQuery();
      return;
    }

    const query = db.collection('transactions')
      .where('userId', '==', userId)
      .where('timestamp', '>=', startDate.toISOString())
      .where('timestamp', '<=', endDate.toISOString())
      .orderBy('timestamp', 'desc');
    await displayTransactions(ctx, query, 1, ` - ${range === '7days' ? 'Last 7 Days' : 'Last 30 Days'}`);
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error fetching ${range} transactions for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? `❌ Problem dey fetching ${range} transactions. Try again later.`
      : `❌ Error fetching ${range} transactions. Try again later.`;
    await ctx.replyWithMarkdown(errorMsg);
    ctx.answerCbQuery();
  }
});

bot.action(/tx_page_(\d+)_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const page = parseInt(ctx.match[1], 10);
  const filterDescription = ctx.match[2].replace(/_/g, ' ');
  try {
    const userState = await getUserState(userId);
    let query = db.collection('transactions').where('userId', '==', userId);

    if (filterDescription.includes('Completed') || filterDescription.includes('Failed') ||
        filterDescription.includes('Pending') || filterDescription.includes('Refunded')) {
      const status = filterDescription.split(' - ')[1];
      query = query.where('status', '==', status);
    } else if (filterDescription.includes('USDC') || filterDescription.includes('USDT')) {
      const asset = filterDescription.split(' - ')[1];
      query = query.where('asset', '==', asset);
    } else if (filterDescription.includes('Last 7 Days') || filterDescription.includes('Last 30 Days')) {
      const range = filterDescription.includes('7 Days') ? 7 : 30;
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(endDate.getDate() - range);
      query = query
        .where('timestamp', '>=', startDate.toISOString())
        .where('timestamp', '<=', endDate.toISOString());
    }

    query = query.orderBy('timestamp', 'desc');
    await displayTransactions(ctx, query, page, filterDescription);
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error navigating transactions page for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Error turning transaction page. Try again later.'
      : '❌ Error navigating transactions. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    ctx.answerCbQuery();
  }
});

bot.action('tx_back', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const prompt = userState.usePidgin
    ? '💰 *Transactions*\n\nPick how you want see them:'
    : '💰 *Transactions*\n\nChoose how to view your transactions:';
  await ctx.editMessageText(prompt, {
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback('📋 All Transactions', 'tx_all')],
      [Markup.button.callback('✅ Completed', 'tx_status_Completed')],
      [Markup.button.callback('❌ Failed', 'tx_status_Failed')],
      [Markup.button.callback('⏳ Pending', 'tx_status_Pending')],
      [Markup.button.callback('🔄 Refunded', 'tx_status_Refunded')],
      [Markup.button.callback('🪙 Filter by Asset', 'tx_filter_asset')],
      [Markup.button.callback('📅 Filter by Date', 'tx_filter_date')]
    ]).reply_markup
  });
  ctx.answerCbQuery();
});

// Handle custom date range input
bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (ctx.session.awaitingCustomDate) {
    const userState = await getUserState(userId);
    const input = ctx.message.text.trim();
    const [start, end] = input.split(' to ').map(s => s.trim());

    try {
      const startDate = new Date(start);
      const endDate = new Date(end);
      if (isNaN(startDate) || isNaN(endDate) || startDate > endDate) {
        const errorMsg = userState.usePidgin
          ? '❌ Date no correct. Use "YYYY-MM-DD to YYYY-MM-DD" (e.g., "2023-01-01 to 2023-01-31").'
          : '❌ Invalid date range. Use "YYYY-MM-DD to YYYY-MM-DD" (e.g., "2023-01-01 to 2023-01-31").';
        await ctx.replyWithMarkdown(errorMsg);
        return;
      }

      const query = db.collection('transactions')
        .where('userId', '==', userId)
        .where('timestamp', '>=', startDate.toISOString())
        .where('timestamp', '<=', endDate.toISOString())
        .orderBy('timestamp', 'desc');
      await displayTransactions(ctx, query, 1, ` - Custom (${start} to ${end})`);
      delete ctx.session.awaitingCustomDate;
    } catch (error) {
      logger.error(`Error processing custom date range for user ${userId}: ${error.message}`);
      const errorMsg = userState.usePidgin
        ? '❌ Problem dey with date range. Try again.'
        : '❌ Error with date range. Try again.';
      await ctx.replyWithMarkdown(errorMsg);
    }
  }
});

// =================== Settings Handler ===================
bot.hears('⚙️ Settings', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const prompt = userState.usePidgin
    ? '⚙️ *Settings*\n\nWetinn you wan change?'
    : '⚙️ *Settings*\n\nWhat would you like to adjust?';
  await ctx.replyWithMarkdown(prompt, getSettingsMenu());
});

bot.action('settings_generate_wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    if (userState.wallets.length >= MAX_WALLETS) {
      const errorMsg = userState.usePidgin
        ? `⚠️ You don reach max wallets (${MAX_WALLETS}).`
        : `⚠️ You’ve reached the maximum wallet limit (${MAX_WALLETS}).`;
      await ctx.replyWithMarkdown(errorMsg);
      ctx.answerCbQuery();
      return;
    }
    await ctx.replyWithMarkdown(userState.usePidgin
      ? '🔄 Generating new wallet... Wait small.'
      : '🔄 Generating a new wallet... Please wait.');
    const walletAddress = await generateWallet('Base');
    userState.wallets.push({
      address: walletAddress,
      chain: 'Base',
      supportedAssets: chains['Base'].supportedAssets,
      bank: null,
      amount: 0,
      creationDate: new Date().toISOString(),
      totalDeposits: 0,
      totalPayouts: 0
    });
    userState.walletAddresses.push(walletAddress);
    await updateUserState(userId, {
      wallets: userState.wallets,
      walletAddresses: userState.walletAddresses
    });
    const successMsg = userState.usePidgin
      ? `✅ New wallet don ready:\n\n*Address:* \`${walletAddress}\`\n*Chain:* Base`
      : `✅ New wallet generated:\n\n*Address:* \`${walletAddress}\`\n*Chain:* Base`;
    await ctx.replyWithMarkdown(successMsg);
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error generating new wallet in settings for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ E no work. Try again later.'
      : '❌ Failed to generate wallet. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    ctx.answerCbQuery();
  }
});

bot.action('settings_edit_bank', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  if (userState.wallets.length === 0) {
    const errorMsg = userState.usePidgin
      ? '❌ No wallet dey to link bank. Generate one first.'
      : '❌ No wallets available to link a bank. Generate one first.';
    await ctx.replyWithMarkdown(errorMsg);
    ctx.answerCbQuery();
    return;
  }
  const keyboard = userState.wallets.map((wallet, index) => [
    Markup.button.callback(`Wallet ${index + 1} - ${wallet.chain}`, `edit_bank_${index}`)
  ]);
  const prompt = userState.usePidgin
    ? '🏦 Pick wallet to edit bank:'
    : '🏦 Select wallet to edit bank details:';
  await ctx.replyWithMarkdown(prompt, Markup.inlineKeyboard(keyboard));
  ctx.answerCbQuery();
});

bot.action(/edit_bank_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);
  ctx.session.walletIndex = walletIndex;
  await ctx.scene.enter('bank_linking_scene');
  ctx.answerCbQuery();
});

bot.action('settings_rename_wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  if (userState.wallets.length === 0) {
    const errorMsg = userState.usePidgin
      ? '❌ No wallet dey to rename. Generate one first.'
      : '❌ No wallets available to rename. Generate one first.';
    await ctx.replyWithMarkdown(errorMsg);
    ctx.answerCbQuery();
    return;
  }
  const keyboard = userState.wallets.map((wallet, index) => [
    Markup.button.callback(`Wallet ${index + 1} - ${wallet.chain}`, `rename_wallet_${index}`)
  ]);
  const prompt = userState.usePidgin
    ? '📝 Pick wallet to rename:'
    : '📝 Select wallet to rename:';
  await ctx.replyWithMarkdown(prompt, Markup.inlineKeyboard(keyboard));
  ctx.answerCbQuery();
});

bot.action(/rename_wallet_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);
  const userState = await getUserState(userId);
  ctx.session.walletIndex = walletIndex;
  const prompt = userState.usePidgin
    ? `📝 Wetin you wan call Wallet ${walletIndex + 1} (${userState.wallets[walletIndex].chain})? Type new name:`
    : `📝 What would you like to name Wallet ${walletIndex + 1} (${userState.wallets[walletIndex].chain})? Enter new name:`;
  await ctx.replyWithMarkdown(prompt);
  ctx.session.awaitingWalletName = true;
  ctx.answerCbQuery();
});

bot.action('settings_language', async (ctx) => {
  const userId = ctx.from.id.toString();
  await ctx.scene.enter('language_selection_scene');
  ctx.answerCbQuery();
});

bot.action('settings_support', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const supportMsg = userState.usePidgin
    ? '💬 Need help? Contact [@maxcswap](https://t.me/maxcswap) or report issue here:'
    : '💬 Need assistance? Contact [@maxcswap](https://t.me/maxcswap) or report an issue below:';
  await ctx.replyWithMarkdown(supportMsg, Markup.inlineKeyboard([
    [Markup.button.callback('📩 Report Issue', 'report_issue')]
  ]));
  ctx.answerCbQuery();
});

bot.action('settings_back_main', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const walletExists = userState.wallets.length > 0;
  const hasBankLinked = userState.wallets.some(wallet => wallet.bank);
  await ctx.editMessageText('👋 Back to main menu!', {
    parse_mode: 'Markdown',
    reply_markup: getMainMenu(walletExists, hasBankLinked).reply_markup
  });
  ctx.answerCbQuery();
});

// Handle wallet rename input
bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (ctx.session.awaitingWalletName) {
    const userState = await getUserState(userId);
    const walletIndex = ctx.session.walletIndex;
    const newName = ctx.message.text.trim();
    if (newName.length > 20) {
      const errorMsg = userState.usePidgin
        ? '❌ Name too long. Keep am under 20 characters.'
        : '❌ Name too long. Keep it under 20 characters.';
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }
    userState.wallets[walletIndex].name = newName;
    await updateUserState(userId, { wallets: userState.wallets });
    const successMsg = userState.usePidgin
      ? `✅ Wallet ${walletIndex + 1} don rename to "${newName}".`
      : `✅ Wallet ${walletIndex + 1} renamed to "${newName}".`;
    await ctx.replyWithMarkdown(successMsg);
    delete ctx.session.awaitingWalletName;
    delete ctx.session.walletIndex;
  }
});

// =================== Support Handler ===================
bot.hears('ℹ️ Support', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const supportMsg = userState.usePidgin
    ? '💬 Need help? Contact [@maxcswap](https://t.me/maxcswap) or report issue here:'
    : '💬 Need assistance? Contact [@maxcswap](https://t.me/maxcswap) or report an issue below:';
  await ctx.replyWithMarkdown(supportMsg, Markup.inlineKeyboard([
    [Markup.button.callback('📩 Report Issue', 'report_issue')]
  ]));
});

bot.action('report_issue', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const prompt = userState.usePidgin
    ? '📩 Wetin dey happen? Type your issue:'
    : '📩 What’s the problem? Please describe your issue:';
  await ctx.replyWithMarkdown(prompt);
  ctx.session.awaitingIssueReport = true;
  ctx.answerCbQuery();
});

bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (ctx.session.awaitingIssueReport) {
    const userState = await getUserState(userId);
    const issue = ctx.message.text.trim();
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ Issue reported by User ${userId}:\n\n${issue}`, { parse_mode: 'Markdown' });
    const successMsg = userState.usePidgin
      ? '✅ Issue don send. We go check am soon.'
      : '✅ Issue reported successfully. We’ll review it soon.';
    await ctx.replyWithMarkdown(successMsg);
    delete ctx.session.awaitingIssueReport;
  }
});

// =================== Learn About Base Handler ===================
bot.hears('📘 Learn About Base', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const learnMsg = userState.usePidgin
    ? '📘 *Wetin be Base?*\n\n' +
      'Base na Layer 2 blockchain wey dey fast and cheap, built on Ethereum. E dey use for quick transactions like sending USDC or USDT. With DirectPay, you fit turn your crypto to cash sharp-sharp!\n\n' +
      'Learn more: [Base Website](https://base.org)'
    : '📘 *What is Base?*\n\n' +
      'Base is a Layer 2 blockchain built on Ethereum, designed for fast and low-cost transactions. It’s perfect for sending assets like USDC or USDT. With DirectPay, you can convert your crypto to cash quickly!\n\n' +
      'Learn more: [Base Website](https://base.org)';
  await ctx.replyWithMarkdown(learnMsg);
});

// =================== View Current Rates Handler ===================
bot.hears('📈 View Current Rates', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  let ratesMessage = userState.usePidgin
    ? '📈 *Current Rates*\n\n'
    : '📈 *Current Exchange Rates*\n\n';
  for (const [asset, rate] of Object.entries(exchangeRates)) {
    ratesMessage += `• *${asset}*: ₦${rate}\n`;
  }
  ratesMessage += userState.usePidgin
    ? '\nRates dey update every 5 mins!'
    : '\nRates are updated every 5 minutes!';
  await ctx.replyWithMarkdown(ratesMessage);
});

// =================== My Stats Handler ===================
bot.hears('📊 My Stats', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    const transactions = await db.collection('transactions')
      .where('userId', '==', userId)
      .get();

    let totalDeposits = 0, totalPayouts = 0, completedTx = 0;
    transactions.forEach(doc => {
      const tx = doc.data();
      totalDeposits += parseFloat(tx.amount || 0);
      totalPayouts += parseFloat(tx.payout || 0);
      if (tx.status === 'Completed') completedTx++;
    });

    const statsMsg = userState.usePidgin
      ? `📊 *Your Stats*\n\n` +
        `• *Total Wallets:* ${userState.wallets.length}\n` +
        `• *Total Deposits:* ${totalDeposits.toFixed(2)} USDC/USDT\n` +
        `• *Total Payouts:* ₦${totalPayouts.toFixed(2)}\n` +
        `• *Completed Transactions:* ${completedTx}\n` +
        `• *Last Active:* ${new Date(userState.lastActive).toLocaleString()}`
      : `📊 *Your Statistics*\n\n` +
        `• *Total Wallets:* ${userState.wallets.length}\n` +
        `• *Total Deposits:* ${totalDeposits.toFixed(2)} USDC/USDT\n` +
        `• *Total Payouts:* ₦${totalPayouts.toFixed(2)}\n` +
        `• *Completed Transactions:* ${completedTx}\n` +
        `• *Last Active:* ${new Date(userState.lastActive).toLocaleString()}`;
    await ctx.replyWithMarkdown(statsMsg);
  } catch (error) {
    logger.error(`Error fetching stats for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey fetching stats. Try again later.'
      : '❌ Error fetching your stats. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
  }
});

// =================== Admin Panel ===================
bot.action('open_admin_panel', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    await ctx.replyWithMarkdown('❌ You no be admin!');
    ctx.answerCbQuery();
    return;
  }
  const prompt = '🔧 *Admin Panel*\n\nWetin you wan do?';
  await ctx.editMessageText(prompt, {
    parse_mode: 'Markdown',
    reply_markup: getAdminMenu().reply_markup
  });
  ctx.answerCbQuery();
});

bot.action('admin_view_all_transactions', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) return;
  try {
    const query = db.collection('transactions')
      .orderBy('timestamp', 'desc');
    await displayTransactions(ctx, query, 1, ' - All (Admin)');
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error fetching all transactions for admin ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('❌ Error fetching transactions.');
    ctx.answerCbQuery();
  }
});

bot.action('admin_view_users', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) return;
  try {
    const usersSnapshot = await db.collection('users').get();
    let message = '👥 *All Users*\n\n';
    usersSnapshot.forEach(doc => {
      const user = doc.data();
      message += `• *User ID:* ${doc.id}\n` +
                 `  *Name:* ${user.firstName || 'Unknown'}\n` +
                 `  *Wallets:* ${user.wallets.length}\n` +
                 `  *Last Active:* ${new Date(user.lastActive).toLocaleString()}\n\n`;
    });
    await ctx.editMessageText(message, { parse_mode: 'Markdown' });
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error fetching users for admin ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('❌ Error fetching users.');
    ctx.answerCbQuery();
  }
});

bot.action('admin_pending_issues', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) return;
  await ctx.replyWithMarkdown('⏳ *Pending Issues*\n\nCheck Telegram support chat for reported issues.');
  ctx.answerCbQuery();
});

bot.action('admin_send_message', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) return;
  await ctx.scene.enter('send_message_scene');
  ctx.answerCbQuery();
});

bot.action('admin_manual_payout', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) return;
  await ctx.replyWithMarkdown('💰 *Manual Payout*\n\nEnter User ID, amount, and asset (e.g., "123456789 100 USDC"):');
  ctx.session.awaitingManualPayout = true;
  ctx.answerCbQuery();
});

bot.action('admin_refund_tx', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) return;
  await ctx.replyWithMarkdown('🔄 *Refund Transaction*\n\nEnter Transaction Reference ID to refund:');
  ctx.session.awaitingRefundTx = true;
  ctx.answerCbQuery();
});

bot.action('admin_analytics', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) return;
  try {
    const usersSnapshot = await db.collection('users').get();
    const txSnapshot = await db.collection('transactions').get();
    let totalUsers = usersSnapshot.size;
    let totalTx = txSnapshot.size;
    let totalDeposits = 0, totalPayouts = 0;
    txSnapshot.forEach(doc => {
      const tx = doc.data();
      totalDeposits += parseFloat(tx.amount || 0);
      totalPayouts += parseFloat(tx.payout || 0);
    });
    const analyticsMsg = `📊 *Bot Analytics*\n\n` +
                         `• *Total Users:* ${totalUsers}\n` +
                         `• *Total Transactions:* ${totalTx}\n` +
                         `• *Total Deposits:* ${totalDeposits.toFixed(2)} USDC/USDT\n` +
                         `• *Total Payouts:* ₦${totalPayouts.toFixed(2)}`;
    await ctx.replyWithMarkdown(analyticsMsg);
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error fetching analytics for admin ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('❌ Error fetching analytics.');
    ctx.answerCbQuery();
  }
});

bot.action('admin_api_status', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) return;
  try {
    const paycrestStatus = await axios.get(PAYCREST_RATE_API_URL, {
      headers: { 'Authorization': `Bearer ${PAYCREST_API_KEY}` }
    });
    const blockradarStatus = await axios.get(chains['Base'].apiUrl, {
      headers: { 'x-api-key': chains['Base'].key }
    });
    const statusMsg = `⚠️ *API/Bot Status*\n\n` +
                      `• *Paycrest API:* ${paycrestStatus.status === 200 ? '✅ Online' : '❌ Offline'}\n` +
                      `• *Blockradar API:* ${blockradarStatus.status === 200 ? '✅ Online' : '❌ Offline'}\n` +
                      `• *Bot:* ✅ Running\n` +
                      `• *Last Rate Update:* ${new Date().toLocaleString()}`;
    await ctx.replyWithMarkdown(statusMsg);
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error checking API status for admin ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('❌ Error checking API status.');
    ctx.answerCbQuery();
  }
});

bot.action('admin_back_to_main', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) return;
  const userState = await getUserState(userId);
  const walletExists = userState.wallets.length > 0;
  const hasBankLinked = userState.wallets.some(wallet => wallet.bank);
  await ctx.editMessageText('👋 Back to main menu!', {
    parse_mode: 'Markdown',
    reply_markup: getMainMenu(walletExists, hasBankLinked).reply_markup
  });
  ctx.answerCbQuery();
});

// Handle manual payout and refund inputs
bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) return;

  if (ctx.session.awaitingManualPayout) {
    const input = ctx.message.text.trim().split(' ');
    if (input.length !== 3) {
      await ctx.replyWithMarkdown('❌ Format no correct. Use "UserID Amount Asset" (e.g., "123456789 100 USDC")');
      return;
    }
    const [targetUserId, amountStr, asset] = input;
    const amount = parseFloat(amountStr);
    if (isNaN(amount) || amount <= 0 || !['USDC', 'USDT'].includes(asset)) {
      await ctx.replyWithMarkdown('❌ Amount or asset no valid.');
      return;
    }

    try {
      const targetUserState = await getUserState(targetUserId);
      if (!targetUserState.wallets.length || !targetUserState.wallets[0].bank) {
        await ctx.replyWithMarkdown('❌ User no get wallet or bank linked.');
        return;
      }
      const wallet = targetUserState.wallets[0];
      const payout = calculatePayout(asset, amount);
      const order = await createPaycrestOrder(targetUserId, amount, asset, wallet.chain, wallet.bank, wallet.address);
      const txData = {
        userId: targetUserId,
        walletAddress: wallet.address,
        amount,
        asset,
        payout,
        status: 'Completed',
        chain: wallet.chain,
        referenceId: order.orderId,
        timestamp: new Date().toISOString(),
        bankDetails: wallet.bank,
        transactionHash: order.transactionHash || 'Manual'
      };
      await db.collection('transactions').doc(order.orderId).set(txData);
      await ctx.replyWithMarkdown(`✅ Manual payout of ₦${payout} sent to User ${targetUserId} for ${amount} ${asset}.`);
      await bot.telegram.sendMessage(targetUserId, generateReceipt(txData, userState.usePidgin ? 'pidgin' : 'en'), { parse_mode: 'Markdown' });
      delete ctx.session.awaitingManualPayout;
    } catch (error) {
      logger.error(`Error processing manual payout for admin ${userId}: ${error.message}`);
      await ctx.replyWithMarkdown('❌ Error processing payout.');
    }
  } else if (ctx.session.awaitingRefundTx) {
    const refId = ctx.message.text.trim();
    try {
      const txDoc = await db.collection('transactions').doc(refId).get();
      if (!txDoc.exists) {
        await ctx.replyWithMarkdown('❌ Transaction no dey.');
        return;
      }
      const tx = txDoc.data();
      if (tx.status === 'Refunded') {
        await ctx.replyWithMarkdown('❌ Transaction don already refund.');
        return;
      }
      const refund = await withdrawFromBlockradar(tx.chain, chains[tx.chain].assets[tx.asset], tx.walletAddress, tx.amount, refId, { reason: 'Admin Refund' });
      await db.collection('transactions').doc(refId).update({
        status: 'Refunded',
        refundAddress: tx.walletAddress,
        refundTimestamp: new Date().toISOString(),
        refundTxHash: refund.transactionHash
      });
      await ctx.replyWithMarkdown(`✅ Transaction ${refId} refunded to ${tx.walletAddress}.`);
      await bot.telegram.sendMessage(tx.userId, `🔄 Your transaction ${refId} has been refunded: ${tx.amount} ${tx.asset} back to your wallet.`, { parse_mode: 'Markdown' });
      delete ctx.session.awaitingRefundTx;
    } catch (error) {
      logger.error(`Error refunding transaction for admin ${userId}: ${error.message}`);
      await ctx.replyWithMarkdown('❌ Error refunding transaction.');
    }
  }
});

// =================== Webhook Handlers ===================
app.post(WEBHOOK_PAYCREST_PATH, async (req, res) => {
  const signature = req.headers['x-paycrest-signature'];
  const rawBody = req.body.toString();

  if (!verifyPaycrestSignature(rawBody, signature, PAYCREST_CLIENT_SECRET)) {
    logger.error('Invalid Paycrest webhook signature.');
    return res.status(401).send('Invalid signature');
  }

  const event = req.body;
  logger.info(`Received Paycrest webhook: ${JSON.stringify(event)}`);

  try {
    const orderId = event.orderId;
    const txDoc = await db.collection('transactions').doc(orderId).get();
    if (!txDoc.exists) {
      logger.error(`Transaction ${orderId} not found in database.`);
      return res.status(404).send('Transaction not found');
    }

    const tx = txDoc.data();
    const userId = tx.userId;
    const userState = await getUserState(userId);

    if (event.status === 'completed') {
      await db.collection('transactions').doc(orderId).update({
        status: 'Completed',
        transactionHash: event.transactionHash,
        payoutTimestamp: new Date().toISOString()
      });
      const receipt = generateReceipt({ ...tx, status: 'Completed', transactionHash: event.transactionHash }, userState.usePidgin ? 'pidgin' : 'en');
      await bot.telegram.sendPhoto(userId, { source: PAYOUT_SUCCESS_IMAGE }, { caption: receipt, parse_mode: 'Markdown' });
      logger.info(`Payout completed for order ${orderId}`);
    } else if (event.status === 'failed') {
      await db.collection('transactions').doc(orderId).update({ status: 'Failed' });
      const failMsg = userState.usePidgin
        ? `❌ Payout fail for ${tx.amount} ${tx.asset}. Contact [@maxcswap](https://t.me/maxcswap). Ref: ${orderId}`
        : `❌ Payout failed for ${tx.amount} ${tx.asset}. Contact [@maxcswap](https://t.me/maxcswap). Ref: ${orderId}`;
      await bot.telegram.sendPhoto(userId, { source: ERROR_IMAGE }, { caption: failMsg, parse_mode: 'Markdown' });
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ Payout failed for user ${userId}: ${orderId}`, { parse_mode: 'Markdown' });
      logger.error(`Payout failed for order ${orderId}`);
    }

    res.status(200).send('Webhook processed');
  } catch (error) {
    logger.error(`Error processing Paycrest webhook: ${error.message}`);
    res.status(500).send('Internal server error');
  }
});

app.post(WEBHOOK_BLOCKRADAR_PATH, async (req, res) => {
  const event = req.body;
  logger.info(`Received Blockradar webhook: ${JSON.stringify(event)}`);

  try {
    const { walletId, address, amount, assetId, chain, transactionHash } = event;
    const userSnapshot = await db.collection('users')
      .where('walletAddresses', 'array-contains', address)
      .limit(1)
      .get();

    if (userSnapshot.empty) {
      logger.error(`No user found for wallet address ${address}`);
      return res.status(404).send('User not found');
    }

    const userDoc = userSnapshot.docs[0];
    const userId = userDoc.id;
    const userState = await getUserState(userId);
    const wallet = userState.wallets.find(w => w.address === address);

    if (!wallet || !wallet.bank) {
      const msg = userState.usePidgin
        ? `⚠️ You send ${amount} ${event.assetSymbol} to ${address} but no bank dey linked. Link bank now!`
        : `⚠️ You sent ${amount} ${event.assetSymbol} to ${address} but no bank is linked. Link a bank now!`;
      await bot.telegram.sendMessage(userId, msg, { parse_mode: 'Markdown', reply_markup: getMainMenu(true, false).reply_markup });
      return res.status(200).send('Webhook processed - no bank linked');
    }

    const payout = calculatePayout(event.assetSymbol, amount);
    const referenceId = generateReferenceId();
    const order = await createPaycrestOrder(userId, amount, event.assetSymbol, chain, wallet.bank, address);

    const txData = {
      userId,
      walletAddress: address,
      amount,
      asset: event.assetSymbol,
      payout,
      status: 'Pending',
      chain,
      referenceId: order.orderId,
      timestamp: new Date().toISOString(),
      bankDetails: wallet.bank,
      transactionHash
    };

    await db.collection('transactions').doc(order.orderId).set(txData);
    wallet.totalDeposits += amount;
    await updateUserState(userId, { wallets: userState.wallets });

    const receipt = generateReceipt(txData, userState.usePidgin ? 'pidgin' : 'en');
    await bot.telegram.sendPhoto(userId, { source: DEPOSIT_SUCCESS_IMAGE }, { caption: receipt, parse_mode: 'Markdown' });
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `💸 Deposit: ${amount} ${event.assetSymbol} from ${userId} to ${address}. Order: ${order.orderId}`, { parse_mode: 'Markdown' });
    logger.info(`Deposit processed for ${userId}: ${amount} ${event.assetSymbol}`);

    res.status(200).send('Webhook processed');
  } catch (error) {
    logger.error(`Error processing Blockradar webhook: ${error.message}`);
    res.status(500).send('Internal server error');
  }
});

// =================== Start Server ===================
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  logger.info('Received SIGTERM. Shutting down gracefully...');
  bot.stop('SIGTERM');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('Received SIGINT. Shutting down gracefully...');
  bot.stop('SIGINT');
  process.exit(0);
});
