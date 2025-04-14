// =================== Import Required Libraries ===================
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
const ethers = require('ethers');
const { v4: uuidv4 } = require('uuid');
const { createClient } = require('@reservoir0x/relay-sdk');
const QRCode = require('qrcode');
const sanitizeHtml = require('sanitize-html'); // Added for input sanitization
require('dotenv').config();

const relayClient = createClient({
  baseUrl: 'https://api.relay.link',
  source: 'DirectPayBot',
});

// =================== Initialize Logging ===================
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json() // Structured logging for easier analysis
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'bot.log', maxsize: 5242880, maxFiles: 5 }),
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
  databaseURL: 'https://directpay9ja.firebaseio.com',
});
const db = admin.firestore();

// =================== Environment Variables ===================
const {
  BOT_TOKEN: TELEGRAM_BOT_TOKEN,
  PAYCREST_API_KEY,
  PAYCREST_CLIENT_SECRET,
  PAYCREST_RATE_API_URL = 'https://api.paycrest.io/v1/rates',
  PAYCREST_RETURN_ADDRESS = '0xYourReturnAddressHere',
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
  ADMIN_IDS,
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
bot.use(session());

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

// =================== Network Mapping ===================
const networkMap = {
  eth: 1,
  base: 8453,
  sol: 792703809,
  polygon: 137,
  bnb: 56,
};

// =================== Define Supported Chains ===================
const chains = {
  Base: {
    id: 'e31c44d6-0344-4ee1-bcd1-c88e89a9e3f1',
    key: BLOCKRADAR_BASE_API_KEY,
    apiUrl: 'https://api.blockradar.co/v1/wallets/e31c44d6-0344-4ee1-bcd1-c88e89a9e3f1/addresses',
    supportedAssets: ['USDC', 'USDT'],
    network: 'Base',
    chainId: 8453,
    assets: { USDC: 'a8aae94e-a2c3-424c-8db5-ea7415166ce3', USDT: 'a8aae94e-a2c3-424c-8db5-ea7415166ce3' },
    explorer: 'https://basescan.org/tx/',
  },
  Polygon: {
    id: 'f4fc4dc4-a0d5-4303-a60b-e58ec1fc6d0a',
    key: BLOCKRADAR_POLYGON_API_KEY,
    apiUrl: 'https://api.blockradar.co/v1/wallets/f4fc4dc4-a0d5-4303-a60b-e58ec1fc6d0a/addresses',
    supportedAssets: ['USDC', 'USDT'],
    network: 'Polygon',
    chainId: 137,
    assets: { USDC: 'f348e8e3-e0b4-4704-857e-c274ef000c00', USDT: 'c9d57a33-375b-46f7-b694-16e9b498e0e1' },
    explorer: 'https://polygonscan.com/tx/',
  },
  'BNB Smart Chain': {
    id: '7a844e91-5740-4589-9695-c74411adec7e',
    key: BLOCKRADAR_BNB_API_KEY,
    apiUrl: 'https://api.blockradar.co/v1/wallets/7a844e91-5740-4589-9695-c74411adec7e/addresses',
    supportedAssets: ['USDT', 'USDC'],
    network: 'BNB Smart Chain',
    chainId: 56,
    assets: { USDC: 'ff479231-0dbb-4760-b695-e219a50934af', USDT: '03a11a51-1422-4ac0-abc0-b2fed75e9fcb' },
    explorer: 'https://bscscan.com/tx/',
  },
};

// =================== Chain Mapping ===================
const chainMapping = {
  base: 'Base',
  polygon: 'Polygon',
  'bnb smart chain': 'BNB Smart Chain',
  'bnb smartchain': 'BNB Smart Chain',
  'bnb chain': 'BNB Smart Chain',
  bnb: 'BNB Smart Chain',
};

// =================== Rate Limiting Storage ===================
const walletGenLimiter = new Map(); // Tracks wallet generation attempts

// =================== Utility Functions ===================
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

    const bank = bankList.find((b) => b.name.toLowerCase() === recipientDetails.bankName.toLowerCase());
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
      providerId: '',
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
        'Content-Type': 'application/json',
      },
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

    const resp = await axios.post(
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
          'x-api-key': chainData.key,
          'Content-Type': 'application/json',
        },
      }
    );
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
        refundAddress: null,
        lastInteraction: new Date().toISOString(), // Track user activity
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
      refundAddress: data.refundAddress || null,
      lastInteraction: data.lastInteraction || new Date().toISOString(),
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
      refundAddress: null,
      lastInteraction: new Date().toISOString(),
    };
  }
}

async function updateUserState(userId, newState) {
  try {
    await db.collection('users').doc(userId).update({
      ...newState,
      lastInteraction: new Date().toISOString(), // Update interaction timestamp
    });
  } catch (error) {
    logger.error(`Error updating user state for ${userId}: ${error.message}`);
    throw error;
  }
}

function encryptPrivateKey(privateKey) {
  const algorithm = 'aes-256-cbc';
  const key = crypto.scryptSync(PAYCREST_CLIENT_SECRET, 'salt', 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  let encrypted = cipher.update(privateKey, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return { iv: iv.toString('hex'), encryptedData: encrypted };
}

function decryptPrivateKey(encryptedObj) {
  const algorithm = 'aes-256-cbc';
  const key = crypto.scryptSync(PAYCREST_CLIENT_SECRET, 'salt', 32);
  const decipher = crypto.createDecipheriv(algorithm, key, Buffer.from(encryptedObj.iv, 'hex'));
  let decrypted = decipher.update(encryptedObj.encryptedData, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

async function generateWallet(chain) {
  try {
    const chainData = chains[chain];
    if (!chainData) throw new Error(`Unsupported chain: ${chain}`);

    const wallet = ethers.Wallet.createRandom();
    return {
      address: wallet.address,
      privateKey: encryptPrivateKey(wallet.privateKey),
    };
  } catch (error) {
    logger.error(`Error generating wallet for ${chain}: ${error.message}`);
    throw error;
  }
}

function generateReceipt(txData) {
  let receiptMessage = `🧾 *Transaction Receipt*\n\n`;
  receiptMessage += `*Reference ID:* \`${txData.referenceId || 'N/A'}\`\n`;
  receiptMessage += `*Amount:* ${txData.amount || 'N/A'} ${txData.asset || 'N/A'}\n`;
  receiptMessage += `*Status:* ${txData.status || 'Pending'}\n`;
  receiptMessage += `*Exchange Rate:* ₦${exchangeRates[txData.asset] || 'N/A'} per ${txData.asset || 'N/A'}\n`;
  receiptMessage += `*Date:* ${txData.timestamp ? new Date(txData.timestamp).toLocaleString() : 'N/A'}\n`;
  receiptMessage += `*Chain:* ${txData.chain || 'N/A'}\n`;
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
  const matrix = Array(b.length + 1)
    .fill(null)
    .map(() => Array(a.length + 1).fill(null));
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

function sanitizeInput(input) {
  return sanitizeHtml(input, {
    allowedTags: [],
    allowedAttributes: {},
  });
}

function limitWalletGeneration(userId) {
  const now = Date.now();
  const limit = walletGenLimiter.get(userId) || { count: 0, start: now };
  if (now - limit.start > 3600 * 1000) {
    limit.count = 0;
    limit.start = now;
  }
  if (limit.count >= 5) return false;
  limit.count += 1;
  walletGenLimiter.set(userId, limit);
  return true;
}

// =================== Define Scenes ===================
const bankLinkingSceneTemp = new Scenes.WizardScene(
  'bank_linking_scene_temp',
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const userState = await getUserState(userId);
    const prompt = userState.usePidgin
      ? '🏦 Enter your bank name for this sell (e.g., GTBank, Access):'
      : '🏦 Please enter your bank name for this sell (e.g., GTBank, Access):';
    await ctx.replyWithMarkdown(prompt);
    ctx.wizard.state.data = { userId };
    return ctx.wizard.next();
  },
  async (ctx) => {
    const bankNameInput = sanitizeInput(ctx.message.text.trim());
    const userState = await getUserState(ctx.wizard.state.data.userId);
    const { bank, distance } = findClosestBank(bankNameInput, bankList);

    if (!bank || distance > 3) {
      const errorMsg = userState.usePidgin
        ? `❌ Bank no match o. Check am or try:\n\n${bankList.map((b) => `• ${b.name}`).join('\n')}`
        : `❌ No matching bank found. Check your input or try:\n\n${bankList.map((b) => `• ${b.name}`).join('\n')}`;
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }

    ctx.wizard.state.data.bankName = bank.name;
    ctx.wizard.state.data.bankCode = bank.code;
    const prompt = userState.usePidgin
      ? '🔢 Enter your 10-digit account number:'
      : '🔢 Please enter your 10-digit account number:';
    await ctx.replyWithMarkdown(prompt);
    return ctx.wizard.next();
  },
  async (ctx) => {
    const accountNumber = sanitizeInput(ctx.message.text.trim());
    const userState = await getUserState(ctx.wizard.state.data.userId);

    if (!/^\d{10}$/.test(accountNumber)) {
      const errorMsg = userState.usePidgin
        ? '❌ Number no correct o. Must be 10 digits:'
        : '❌ Invalid account number. Must be 10 digits:';
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }

    ctx.wizard.state.data.accountNumber = accountNumber;

    const verifyingMsg = userState.usePidgin
      ? '🔄 Checking your bank details with Paystack...'
      : '🔄 Verifying your bank details with Paystack...';
    await ctx.replyWithMarkdown(verifyingMsg);

    try {
      const verificationResult = await verifyBankAccount(accountNumber, ctx.wizard.state.data.bankCode);

      if (!verificationResult || !verificationResult.data || !verificationResult.data.account_name) {
        throw new Error('Invalid verification response from Paystack.');
      }

      const accountName = verificationResult.data.account_name;
      ctx.wizard.state.data.accountName = accountName;

      const relayAddress = `relay_${uuidv4().replace(/-/g, '')}`;
      ctx.wizard.state.data.bankDetails = {
        bankName: ctx.wizard.state.data.bankName,
        bankCode: ctx.wizard.state.data.bankCode,
        accountNumber,
        accountName,
        relayAddress,
      };

      const confirmMsg = userState.usePidgin
        ? `🏦 *Bank Details*\n` +
          `- *Bank:* ${ctx.wizard.state.data.bankName}\n` +
          `- *Number:* \`${accountNumber}\`\n` +
          `- *Name:* ${accountName}\n\n` +
          `E correct?`
        : `🏦 *Bank Details*\n` +
          `- *Bank:* ${ctx.wizard.state.data.bankName}\n` +
          `- *Account Number:* \`${accountNumber}\`\n` +
          `- *Account Name:* ${accountName}\n\n` +
          `Is this correct?`;
      await ctx.replyWithMarkdown(confirmMsg, Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes', 'confirm_bank_temp')],
        [Markup.button.callback('❌ No', 'retry_bank_temp')],
      ]));
      return ctx.wizard.next();
    } catch (error) {
      logger.error(`Paystack verification failed for user ${userId}: ${error.message}`);
      const errorMsg = userState.usePidgin
        ? '❌ E no work o. Check your details or try again.'
        : '❌ Verification failed. Check your details and try again.';
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }
  },
  async (ctx) => {
    const callbackData = ctx.callbackQuery?.data;
    const userState = await getUserState(ctx.wizard.state.data.userId);

    if (!callbackData) return;

    if (callbackData === 'retry_bank_temp') {
      const prompt = userState.usePidgin
        ? '🏦 Enter bank name again:'
        : '🏦 Enter your bank name again:';
      await ctx.replyWithMarkdown(prompt);
      return ctx.wizard.selectStep(1);
    } else if (callbackData === 'confirm_bank_temp') {
      ctx.scene.state.bankDetails = ctx.wizard.state.data.bankDetails;
      const successMsg = userState.usePidgin
        ? `✅ Bank linked for this sell:\n` +
          `- *Bank:* ${ctx.wizard.state.data.bankDetails.bankName}\n` +
          `- *Number:* ${ctx.wizard.state.data.bankDetails.accountNumber}\n` +
          `- *Name:* ${ctx.wizard.state.data.bankDetails.accountName}`
        : `✅ Bank linked for this sell:\n` +
          `- *Bank:* ${ctx.wizard.state.data.bankDetails.bankName}\n` +
          `- *Account Number:* ${ctx.wizard.state.data.bankDetails.accountNumber}\n` +
          `- *Account Name:* ${ctx.wizard.state.data.bankDetails.accountName}`;
      await ctx.replyWithMarkdown(successMsg);
      await ctx.answerCbQuery();
      return ctx.scene.leave();
    }
  }
);

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
    const input = sanitizeInput(ctx.message.text.trim());
    logger.info(`User ${userId} entered bank name: ${input}`);

    const userState = await getUserState(userId);
    const { bank, distance } = findClosestBank(input, bankList);

    if (!bank || distance > 3) {
      const errorMsg = userState.usePidgin
        ? `❌ Bank name no match o. Check your spelling or try:\n\n${bankList.map((b) => `• ${b.name}`).join('\n')}\n\nTry again or type "exit" to stop.`
        : `❌ No matching bank found. Check your spelling or try:\n\n${bankList.map((b) => `• ${b.name}`).join('\n')}\n\nTry again or type "exit" to cancel.`;
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
        [Markup.button.callback('❌ No', 'retry_bank_name')],
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
    const input = sanitizeInput(ctx.message.text.trim());
    logger.info(`User ${userId} entered account number: ${input}`);

    const userState = await getUserState(userId);
    if (input.toLowerCase() === 'exit') {
      const cancelMsg = userState.usePidgin ? '❌ Bank linking don cancel.' : '❌ Bank linking cancelled.';
      await ctx.replyWithMarkdown(cancelMsg);
      return ctx.scene.leave();
    }

    if (!/^\d{10}$/.test(input)) {
      const errorMsg = userState.usePidgin
        ? '❌ Account number no correct. Enter valid 10-digit number or type "exit" to stop:'
        : '❌ Invalid account number. Please enter a valid 10-digit number or type "exit" to cancel:';
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
        ? '❌ E no work. Check your details, try again, or type "exit" to stop.'
        : '❌ Failed to verify your bank account. Check your details, try again, or type "exit" to cancel.';
      await ctx.replyWithMarkdown(errorMsg);
      return;
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
    const qrCodeData = await QRCode.toBuffer(walletAddress, { width: 200 });
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
        `You fit start receive payouts now.\n\n*Refund Address:* Set one in "⚙️ Settings" if payout fail (default na this wallet).`
      : `✅ *Bank Account Linked*\n\n` +
        `*Bank Name:* ${bankData.bankName}\n` +
        `*Account Number:* \`${bankData.accountNumber}\`\n` +
        `*Account Holder:* ${bankData.accountName}\n\n` +
        `📂 *Wallet Details:*\n` +
        `• *Chain:* ${userState.wallets[walletIndex].chain}\n` +
        `• *Address:* \`${walletAddress}\`\n\n` +
        `You can now receive payouts.\n\n*Refund Address:* Set one in "⚙️ Settings" for failed payouts (defaults to this wallet).`;

    await ctx.replyWithPhoto({ source: createReadStream(tempFilePath) }, {
      caption: confirmationMessage,
      parse_mode: 'Markdown',
      reply_markup: getMainMenu(true, true),
    });

    await unlinkAsync(tempFilePath);

    await bot.telegram.sendMessage(
      PERSONAL_CHAT_ID,
      `🔗 User ${userId} linked a bank account:\n\n*Account Name:* ${bankData.accountName}\n*Bank Name:* ${bankData.bankName}\n*Account Number:* ****${bankData.accountNumber.slice(-4)}`,
      { parse_mode: 'Markdown' }
    );
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
  const retryMsg = userState.usePidgin
    ? '⚠️ Let’s start over. Enter your bank name again (e.g., GTBank, Access):'
    : "⚠️ Let's try again. Please enter your bank name again (e.g., GTBank, Access):";
  await ctx.replyWithMarkdown(retryMsg);
  ctx.session.bankData = {};
  ctx.session.bankData.step = 1;
  await ctx.answerCbQuery();
  ctx.wizard.selectStep(1);
});

bankLinkingScene.action('cancel_bank_linking', async (ctx) => {
  const userState = await getUserState(ctx.from.id.toString());
  const errorMsg = userState.usePidgin ? '❌ Bank linking cancelled.' : '❌ Bank linking process cancelled.';
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
    const userIdToMessage = sanitizeInput(ctx.message.text.trim());
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
      const caption = sanitizeInput(ctx.message.caption || '');

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
      const messageContent = sanitizeInput(ctx.message.text.trim());
      if (!messageContent) {
        const errorMsg = userState.usePidgin
          ? '❌ Message no fit empty. Enter something.'
          : '❌ Message content cannot be empty. Please enter a message:';
        await ctx.replyWithMarkdown(errorMsg);
        return;
      }

      try {
        await bot.telegram.sendMessage(userIdToMessage, `📩 *Message from Admin:*\n\n${messageContent}`, {
          parse_mode: 'Markdown',
        });
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
      Markup.button.callback(`Wallet ${index + 1} - ${wallet.chain}`, `select_receipt_wallet_${index}`),
    ]);
    const prompt = userState.usePidgin ? 'Pick wallet for receipt:' : 'Select wallet for receipt:';
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

      const transactionsSnapshot = await db
        .collection('transactions')
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
        ? '📥 Click to export receipt as text:'
        : '📥 Click to export this receipt as text:';
      await ctx.replyWithMarkdown(receiptMessage + exportMsg, Markup.inlineKeyboard([
        [Markup.button.callback('📤 Export', `export_receipt_${walletIndex}`)],
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

// Placeholder for sellScene (assumed to be in sellScene.js)
const sellSceneModule = require('./sellScene');
const sellScene = sellSceneModule.sellScene;

// Register all scenes
const stage = new Scenes.Stage([bankLinkingScene, sendMessageScene, receiptGenerationScene, bankLinkingSceneTemp, sellScene]);
bot.use(stage.middleware());
sellSceneModule.setup(bot, db, logger, getUserState);

// /sell command handler
bot.command('sell', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  await bot.telegram.sendChatAction(ctx.chat.id, 'typing');
  if (userState.wallets.length === 0 || !userState.wallets.some((w) => w.bank)) {
    const errorMsg = userState.usePidgin
      ? '❌ You no get wallet or bank linked yet. Go "💼 Generate Wallet" and link bank first.'
      : '❌ You don’t have a wallet or linked bank yet. Please generate a wallet and link a bank first.';
    await ctx.replyWithMarkdown(errorMsg);
    return;
  }
  try {
    await ctx.scene.enter('sell_scene');
  } catch (error) {
    logger.error(`Error entering sell_scene for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('❌ Something went wrong. Try again later.');
  }
});

// =================== Webhook Setup ===================
if (WEBHOOK_DOMAIN && WEBHOOK_PATH) {
  const webhookURL = `${WEBHOOK_DOMAIN}${WEBHOOK_PATH}`;
  bot.telegram
    .setWebhook(webhookURL)
    .then(() => logger.info(`Webhook set to ${webhookURL}`))
    .catch((err) => logger.error(`Failed to set webhook: ${err.message}`));
  app.use(bot.webhookCallback(WEBHOOK_PATH));
} else {
  logger.warn('WEBHOOK_DOMAIN or WEBHOOK_PATH not set. Falling back to long polling.');
  bot
    .launch()
    .then(() => logger.info('Bot started using long polling.'))
    .catch((err) => logger.error(`Failed to launch bot: ${err.message}`));
}

// =================== Middlewares ===================
app.use(requestIp.mw());
app.post(WEBHOOK_PAYCREST_PATH, bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  await handlePaycrestWebhook(req, res);
});
app.use(bodyParser.json());

const SUPPORTED_ASSETS = ['USDC', 'USDT'];
let exchangeRates = { USDC: 0, USDT: 0 };

async function fetchExchangeRate(asset) {
  try {
    const response = await axios.get(`${PAYCREST_RATE_API_URL}`, {
      headers: { Authorization: `Bearer ${PAYCREST_API_KEY}`, 'Content-Type': 'application/json' },
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
setInterval(fetchExchangeRates, 300000); // 5 minutes

// =================== Menus ===================
const getMainMenu = (walletExists, hasBankLinked) =>
  Markup.keyboard([
    [walletExists ? '💼 View Wallet' : '💼 Generate Wallet', '⚙️ Settings'],
    ['💰 Transactions', '📘 Learn About Base', 'ℹ️ Support'],
    ['📈 View Current Rates'],
    ['/sell'], // Added sell command to main menu
  ]).resize();

const getSettingsMenu = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Generate New Wallet', 'settings_generate_wallet')],
    [Markup.button.callback('✏️ Edit Bank Details', 'settings_edit_bank')],
    [Markup.button.callback('📝 Rename Wallet', 'settings_rename_wallet')],
    [Markup.button.callback('🔙 Set Refund Address', 'settings_set_refund_address')],
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
    [Markup.button.callback('⚠️ API/Bot Status', 'admin_api_status')],
    [Markup.button.callback('🔙 Back to Main Menu', 'admin_back_to_main')],
  ]);

// =================== Admin Check ===================
const isAdmin = (userId) => ADMIN_IDS.split(',').map((id) => id.trim()).includes(userId.toString());

// =================== Commands ===================
bot.command('start', async (ctx) => {
  await bot.telegram.sendChatAction(ctx.chat.id, 'typing');
  try {
    await greetUser(ctx);
  } catch (error) {
    logger.error(`Error in /start command: ${error.message}`);
    await ctx.replyWithMarkdown('❌ Something went wrong. Try again later.');
  }
});

bot.command('help', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  await bot.telegram.sendChatAction(ctx.chat.id, 'typing');

  let helpMsg = userState.usePidgin
    ? '🛠️ *How to Use DirectPay*\n\n'
    : '🛠️ *How to Use DirectPay*\n\n';

  if (userState.wallets.length === 0) {
    helpMsg += userState.usePidgin
      ? 'You no get wallet yet. Click "💼 Generate Wallet" to start!\n\n'
      : 'You don’t have a wallet yet. Click "💼 Generate Wallet" to get started!\n\n';
  } else if (!userState.wallets.some((w) => w.bank)) {
    helpMsg += userState.usePidgin
      ? 'You get wallet but no bank linked. Go "⚙️ Settings" to add bank!\n\n'
      : 'You have a wallet but no bank linked. Go to "⚙️ Settings" to link a bank!\n\n';
  } else {
    helpMsg += userState.usePidgin
      ? 'You dey set! Use these:\n' +
        '- 💼 *View Wallet*: Check your wallet details.\n' +
        '- /sell: Sell your crypto fast.\n' +
        '- 💰 *Transactions*: See all your deals.\n' +
        '- ⚙️ *Settings*: Manage wallet or bank.\n' +
        '- 📈 *View Current Rates*: Check latest rates.\n\n'
      : 'You’re all set! Try these:\n' +
        '- 💼 *View Wallet*: Check your wallet details.\n' +
        '- /sell: Sell your crypto quickly.\n' +
        '- 💰 *Transactions*: View your transaction history.\n' +
        '- ⚙️ *Settings*: Manage wallets or bank details.\n' +
        '- 📈 *View Current Rates*: See the latest rates.\n\n';
  }

  helpMsg += userState.usePidgin
    ? 'Need more help? Hit "ℹ️ Support" or ping [@maxcswap](https://t.me/maxcswap).'
    : 'Need more help? Click "ℹ️ Support" or contact [@maxcswap](https://t.me/maxcswap).';

  await ctx.replyWithMarkdown(helpMsg);
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
  const hasBankLinked = userState.wallets.some((wallet) => wallet.bank);
  const adminUser = isAdmin(userId);

  const greeting = walletExists
    ? userState.usePidgin
      ? `👋 Welcome back, ${userState.firstName}!\n\nThis na **DirectPay**, your crypto-to-cash plug.\n\n💡 *How to Start:*\n1. Link bank with "⚙️ Settings"\n2. Check your wallet address\n3. Send stablecoins, get cash fast.\n\nRates dey fresh, money dey safe!\n\n*Refund Address:* Set one in "⚙️ Settings" if payout fail (default na your wallet).`
      : `👋 Welcome back, ${userState.firstName}!\n\nThis is **DirectPay**, your crypto-to-cash solution.\n\n💡 *Quick Start:*\n1. Link your bank in "⚙️ Settings"\n2. View your wallet address\n3. Send stablecoins, receive cash quickly.\n\nRates are updated, funds are secure!\n\n*Refund Address:* Set one in "⚙️ Settings" for failed payouts (defaults to your wallet).`
    : userState.usePidgin
      ? `👋 Hello, ${userState.firstName}!\n\nWelcome to **DirectPay**. Let’s start your crypto journey. Use the menu below.\n\nTry "💼 Generate Wallet" to begin!`
      : `👋 Hello, ${userState.firstName}!\n\nWelcome to **DirectPay**. Let’s begin your crypto journey. Use the menu below.\n\nTry "💼 Generate Wallet" to get started!`;

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
  await bot.telegram.sendChatAction(ctx.chat.id, 'typing');

  if (ctx.scene.current && ctx.scene.current.id === 'bank_linking_scene') {
    const userState = await getUserState(userId);
    const msg = userState.usePidgin
      ? '⚠️ You dey link bank now. Finish am first or type "exit" to stop.'
      : '⚠️ You’re currently linking a bank. Finish that first or type "exit" to cancel.';
    await ctx.replyWithMarkdown(msg);
    return;
  }

  try {
    const userState = await getUserState(userId);

    if (!limitWalletGeneration(userId)) {
      const errorMsg = userState.usePidgin
        ? '⚠️ You don try too many times. Wait small before you try again.'
        : '⚠️ Too many wallet generation attempts. Please wait before trying again.';
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }

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
    const generatingMessage = await ctx.replyWithMarkdown(
      userState.usePidgin ? `🔄 Generating wallet for ${chain}. Wait small...` : `🔄 Generating your wallet on ${chain}. Please wait...`
    );

    try {
      const wallet = await generateWallet(chain);
      userState.wallets.push({
        address: wallet.address,
        privateKey: wallet.privateKey,
        chain: chain,
        supportedAssets: chains[chain].supportedAssets,
        bank: null,
        amount: 0,
        creationDate: new Date().toISOString(),
        totalDeposits: 0,
        totalPayouts: 0,
      });
      userState.walletAddresses.push(wallet.address);

      await updateUserState(userId, {
        wallets: userState.wallets,
        walletAddresses: userState.wallets.map((w) => w.address),
      });

      await bot.telegram.sendMessage(
        PERSONAL_CHAT_ID,
        `💼 Wallet generated for user ${userId} on ${chain}: ${wallet.address}`,
        { parse_mode: 'Markdown' }
      );
      logger.info(`Wallet generated for user ${userId} on ${chain}: ${wallet.address}`);

      const newWalletIndex = userState.wallets.length - 1;
      ctx.session.walletIndex = newWalletIndex;

      await ctx.deleteMessage(generatingMessage.message_id);

      const tempFilePath = path.join(__dirname, `temp_qr_${userId}_${Date.now()}.png`);
      const qrCodeData = await QRCode.toBuffer(wallet.address, { width: 200 });
      if (!fs.existsSync(WALLET_GENERATED_IMAGE)) {
        throw new Error(`Base image not found at ${WALLET_GENERATED_IMAGE}`);
      }

      await sharp(WALLET_GENERATED_IMAGE)
        .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
        .composite([{ input: qrCodeData, top: 250, left: 210 }])
        .png()
        .toFile(tempFilePath);

      const successMsg = userState.usePidgin
        ? `✅ *Wallet Ready*\n\n` +
          `*Networks:* Base, BNB Smart Chain, Polygon (EVM Compatible)\n` +
          `*Assets:* USDC, USDT\n` +
          `*Address:* \`${wallet.address}\`\n\n` +
          `Let’s link your bank now to start using it.\n\n*Refund Address:* Set one in "⚙️ Settings" if payout fail (default na this wallet).`
        : `✅ *Wallet Generated*\n\n` +
          `*Networks:* Base, BNB Smart Chain, Polygon (EVM Compatible)\n` +
          `*Assets:* USDC, USDT\n` +
          `*Address:* \`${wallet.address}\`\n\n` +
          `Let’s link your bank now to start using it.\n\n*Refund Address:* Set one in "⚙️ Settings" for failed payouts (defaults to this wallet).`;

      await ctx.replyWithPhoto(
        { source: createReadStream(tempFilePath) },
        {
          caption: successMsg,
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🏦 Link Bank Now', 'link_bank_now')]]),
        }
      );

      await unlinkAsync(tempFilePath);

      if (suggestPidgin && !userState.usePidgin) {
        await ctx.replyWithMarkdown('👋 You dey Nigeria? Type "Pidgin" to switch if you like.');
      }
    } catch (error) {
      logger.error(`Error generating wallet for user ${userId} on ${chain}: ${error.message}`);
      const errorMsg = userState.usePidgin
        ? '❌ Problem dey. Try again later.'
        : '❌ Something went wrong. Please try again later.';
      await ctx.replyWithMarkdown(errorMsg);
      await bot.telegram.sendMessage(
        PERSONAL_CHAT_ID,
        `❗️ Error generating wallet for user ${userId}: ${error.message}`,
        { parse_mode: 'Markdown' }
      );
      await ctx.deleteMessage(generatingMessage.message_id);
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

bot.action('link_bank_now', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  await ctx.answerCbQuery();
  try {
    await ctx.scene.enter('bank_linking_scene');
  } catch (error) {
    logger.error(`Error entering bank_linking_scene for user ${userId}: ${error.message}`);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Something went wrong. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
  }
});

// =================== View Wallet Handler ===================
bot.hears('💼 View Wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  const ip = ctx.requestIp || 'Unknown';
  let suggestPidgin = ip.startsWith('41.') || ip.startsWith('197.') || ip.startsWith('105.');
  await bot.telegram.sendChatAction(ctx.chat.id, 'typing');

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

      message += userState.usePidgin
        ? `\n💡 *Next Steps*: ${wallets.some((w) => w.bank) ? 'Try "/sell" to cash out!' : 'Link a bank in "⚙️ Settings" to start selling.'}`
        : `\n💡 *Next Steps*: ${wallets.some((w) => w.bank) ? 'Try "/sell" to sell your crypto!' : 'Link a bank in "⚙️ Settings" to start selling.'}`;

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
  await bot.telegram.sendChatAction(ctx.chat.id, 'typing');

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

      message += userState.usePidgin
        ? `\n💡 *Next Steps*: ${wallets.some((w) => w.bank) ? 'Try "/sell" to cash out!' : 'Link a bank in "⚙️ Settings" to start selling.'}`
        : `\n💡 *Next Steps*: ${wallets.some((w) => w.bank) ? 'Try "/sell" to sell your crypto!' : 'Link a bank in "⚙️ Settings" to start selling.'}`;

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
        reply_markup: inlineKeyboard.reply_markup,
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
  await bot.telegram.sendChatAction(ctx.chat.id, 'typing');
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
      [Markup.button.callback('📅 Filter by Date', 'tx_filter_date')],
    ]);

    const sentMessage = await ctx.replyWithMarkdown(initialPrompt, inlineKeyboard);
    ctx.session.txMessageId = sentMessage.message_id;
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

  try {
    const transactionsSnapshot = await query.limit(pageSize).offset((page - 1) * pageSize).get();
    const totalDocsSnapshot = await query.count().get();
    const totalDocs = totalDocsSnapshot.data().count;
    const totalPages = Math.max(1, Math.ceil(totalDocs / pageSize));

    const timestamp = new Date().toISOString();
    let message = userState.usePidgin
      ? `💰 *Transactions*${filterDescription} (Page ${page}/${totalPages})\n*Updated:* ${timestamp}\n\n`
      : `💰 *Transactions*${filterDescription} (Page ${page}/${totalPages})\n*Updated:* ${timestamp}\n\n`;

    if (transactionsSnapshot.empty) {
      message += userState.usePidgin ? 'No transactions here yet.' : 'No transactions found yet.';
    } else {
      transactionsSnapshot.forEach((doc) => {
        const tx = doc.data();
        const chain = tx.chain || 'Base';
        const blockExplorerUrl = chains[chain]?.explorer ? `${chains[chain].explorer}${tx.transactionHash}` : '#';
        message += userState.usePidgin
          ? `*Ref ID:* \`${tx.referenceId || 'N/A'}\`\n` +
            `• *Asset:* ${tx.asset || 'N/A'}\n` +
            `• *Amount:* ${tx.amount || 'N/A'}\n` +
            `• *Payout:* ₦${tx.payout || 'N/A'}\n` +
            `• *Status:* ${tx.status || 'Pending'}\n` +
            `• *Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleDateString() : 'N/A'}\n` +
            `• *Chain:* ${tx.chain || 'N/A'}\n` +
            (tx.status === 'Completed'
              ? `• *Tx Hash:* [${tx.transactionHash || 'N/A'}](${blockExplorerUrl})\n` +
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
              ? `• *Transaction Hash:* [${tx.transactionHash || 'N/A'}](${blockExplorerUrl})\n` +
                `• *Paid To:* ${tx.bankDetails?.bankName || 'N/A'} (****${tx.bankDetails?.accountNumber?.slice(-4) || 'N/A'})\n` +
                `• *Receiver:* ${tx.bankDetails?.accountName || 'N/A'}\n`
              : tx.status === 'Refunded'
              ? `• *Refunded To:* \`${tx.refundAddress || tx.walletAddress || 'N/A'}\`\n`
              : '') +
            `\n`;
      });
    }

    message += userState.usePidgin
      ? `\n💡 *Next Steps*: ${userState.wallets.some((w) => w.bank) ? 'Try "/sell" to cash out more!' : 'Link a bank in "⚙️ Settings" to start selling.'}`
      : `\n💡 *Next Steps*: ${userState.wallets.some((w) => w.bank) ? 'Try "/sell" to sell more crypto!' : 'Link a bank in "⚙️ Settings" to start selling.'}`;

    const navigationButtons = [];
    if (page > 1) navigationButtons.push(Markup.button.callback('⬅️ Previous', `tx_page_${page - 1}_${filterDescription.replace(/\s/g, '_')}`));
    if (page < totalPages) navigationButtons.push(Markup.button.callback('Next ➡️', `tx_page_${page + 1}_${filterDescription.replace(/\s/g, '_')}`));
    navigationButtons.push(Markup.button.callback('🔄 Refresh', `tx_page_${page}_${filterDescription.replace(/\s/g, '_')}`));
    navigationButtons.push(Markup.button.callback('🏠 Exit', 'tx_exit'));

    const inlineKeyboard = Markup.inlineKeyboard([navigationButtons]);
    if (ctx.session.txMessageId) {
      await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.txMessageId, null, message, {
        parse_mode: 'Markdown',
        reply_markup: inlineKeyboard.reply_markup,
      });
    } else {
      const sentMessage = await ctx.replyWithMarkdown(message, inlineKeyboard);
      ctx.session.txMessageId = sentMessage.message_id;
    }
  } catch (error) {
    logger.error(`Error displaying transactions for user ${userId}: ${error.message}`);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Error occurred. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
  }
}

// =================== Transaction Action Handlers ===================
bot.action('tx_all', async (ctx) => {
  const userId = ctx.from.id.toString();
  await bot.telegram.sendChatAction(ctx.chat.id, 'typing');
  try {
    const query = db.collection('transactions').where('userId', '==', userId).orderBy('timestamp', 'desc');
    await displayTransactions(ctx, query, 1, ' - All Transactions');
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error displaying all transactions for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Error occurred. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    ctx.answerCbQuery();
  }
});

bot.action(/tx_status_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const status = ctx.match[1];
  await bot.telegram.sendChatAction(ctx.chat.id, 'typing');
  try {
    const query = db
      .collection('transactions')
      .where('userId', '==', userId)
      .where('status', '==', status)
      .orderBy('timestamp', 'desc');
    await displayTransactions(ctx, query, 1, ` - ${status} Transactions`);
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error displaying ${status} transactions for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Error occurred. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    ctx.answerCbQuery();
  }
});

bot.action('tx_filter_asset', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  await bot.telegram.sendChatAction(ctx.chat.id, 'typing');
  const prompt = userState.usePidgin
    ? '🪙 Pick asset to filter:'
    : '🪙 Select asset to filter by:';
  if (ctx.session.txMessageId) {
    await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.txMessageId, null, prompt, {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('USDC', 'tx_asset_USDC')],
        [Markup.button.callback('USDT', 'tx_asset_USDT')],
        [Markup.button.callback('🔙 Back', 'tx_back')],
      ]).reply_markup,
    });
  } else {
    const sentMessage = await ctx.replyWithMarkdown(prompt, Markup.inlineKeyboard([
      [Markup.button.callback('USDC', 'tx_asset_USDC')],
      [Markup.button.callback('USDT', 'tx_asset_USDT')],
      [Markup.button.callback('🔙 Back', 'tx_back')],
    ]));
    ctx.session.txMessageId = sentMessage.message_id;
  }
  ctx.answerCbQuery();
});

bot.action(/tx_asset_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const asset = ctx.match[1];
  await bot.telegram.sendChatAction(ctx.chat.id, 'typing');
  try {
    const query = db
      .collection('transactions')
      .where('userId', '==', userId)
      .where('asset', '==', asset)
      .orderBy('timestamp', 'desc');
    await displayTransactions(ctx, query, 1, ` - ${asset} Transactions`);
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error displaying ${asset} transactions for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Error occurred. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    ctx.answerCbQuery();
  }
});

bot.action('tx_filter_date', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  await bot.telegram.sendChatAction(ctx.chat.id, 'typing');
  const currentDate = new Date();
  const months = [];
  for (let i = 0; i < 3; i++) {
    const date = new Date(currentDate.getFullYear(), currentDate.getMonth() - i, 1);
    const monthName = date.toLocaleString('default', { month: 'long' });
    months.push([Markup.button.callback(`${monthName} ${date.getFullYear()}`, `tx_date_${monthName}_${date.getFullYear()}`)]);
  }
  months.push([Markup.button.callback('🔙 Back', 'tx_back')]);

  const prompt = userState.usePidgin
    ? '📅 Pick month to filter:'
    : '📅 Select month to filter by:';
  if (ctx.session.txMessageId) {
    await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.txMessageId, null, prompt, {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard(months).reply_markup,
    });
  } else {
    const sentMessage = await ctx.replyWithMarkdown(prompt, Markup.inlineKeyboard(months));
    ctx.session.txMessageId = sentMessage.message_id;
  }
  ctx.answerCbQuery();
});

bot.action(/tx_date_(.+)_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const month = ctx.match[1];
  const year = parseInt(ctx.match[2], 10);
  await bot.telegram.sendChatAction(ctx.chat.id, 'typing');
  try {
    const startDate = new Date(`${month} 1, ${year}`);
    const endDate = new Date(year, startDate.getMonth() + 1, 0, 23, 59, 59, 999);

    const query = db
      .collection('transactions')
      .where('userId', '==', userId)
      .where('timestamp', '>=', startDate.toISOString())
      .where('timestamp', '<=', endDate.toISOString())
      .orderBy('timestamp', 'desc');

    await displayTransactions(ctx, query, 1, ` - ${month} ${year}`);
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error displaying transactions for ${month} ${year} for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Error occurred. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    ctx.answerCbQuery();
  }
});

bot.action('tx_back', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  await bot.telegram.sendChatAction(ctx.chat.id, 'typing');
  const prompt = userState.usePidgin
    ? '💰 *Transactions*\n\nPick how you want see them:'
    : '💰 *Transactions*\n\nChoose how to view your transactions:';

  if (ctx.session.txMessageId) {
    await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.txMessageId, null, prompt, {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('📋 All Transactions', 'tx_all')],
        [Markup.button.callback('✅ Completed', 'tx_status_Completed')],
        [Markup.button.callback('❌ Failed', 'tx_status_Failed')],
        [Markup.button.callback('⏳ Pending', 'tx_status_Pending')],
        [Markup.button.callback('🔄 Refunded', 'tx_status_Refunded')],
        [Markup.button.callback('🪙 Filter by Asset', 'tx_filter_asset')],
        [Markup.button.callback('📅 Filter by Date', 'tx_filter_date')],
      ]).reply_markup,
    });
  } else {
    const sentMessage = await ctx.replyWithMarkdown(prompt, Markup.inlineKeyboard([
      [Markup.button.callback('📋 All Transactions', 'tx_all')],
      [Markup.button.callback('✅ Completed', 'tx_status_Completed')],
      [Markup.button.callback('❌ Failed', 'tx_status_Failed')],
      [Markup.button.callback('⏳ Pending', 'tx_status_Pending')],
      [Markup.button.callback('🔄 Refunded', 'tx_status_Refunded')],
      [Markup.button.callback('🪙 Filter by Asset', 'tx_filter_asset')],
      [Markup.button.callback('📅 Filter by Date', 'tx_filter_date')],
    ]));
    ctx.session.txMessageId = sentMessage.message_id;
  }
  ctx.answerCbQuery();
});

bot.action('tx_exit', async (ctx) => {
  const userId = ctx.from.id.toString();
  await bot.telegram.sendChatAction(ctx.chat.id, 'typing');
  await greetUser(ctx);
  ctx.answerCbQuery();
});

bot.action(/tx_page_(\d+)_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const page = parseInt(ctx.match[1], 10);
  const filterDescription = ctx.match[2].replace(/_/g, ' ');
  await bot.telegram.sendChatAction(ctx.chat.id, 'typing');

  try {
    let query = db.collection('transactions').where('userId', '==', userId).orderBy('timestamp', 'desc');

    if (filterDescription.includes('Completed') || filterDescription.includes('Failed') || filterDescription.includes('Pending') || filterDescription.includes('Refunded')) {
      const status = filterDescription.split(' - ')[1].replace(' Transactions', '');
      query = query.where('status', '==', status);
    } else if (filterDescription.includes('USDC') || filterDescription.includes('USDT')) {
      const asset = filterDescription.split(' - ')[1].replace(' Transactions', '');
      query = query.where('asset', '==', asset);
    } else if (filterDescription.match(/\w+ \d{4}/)) {
      const [month, year] = filterDescription.split(' - ')[1].split(' ');
      const startDate = new Date(`${month} 1, ${year}`);
      const endDate = new Date(year, startDate.getMonth() + 1, 0, 23, 59, 59, 999);
      query = query.where('timestamp', '>=', startDate.toISOString()).where('timestamp', '<=', endDate.toISOString());
    }

    await displayTransactions(ctx, query, page, filterDescription);
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error navigating transaction page for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Error occurred. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
  }
});

// =================== Support Handler ===================
bot.hears('ℹ️ Support', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  await bot.telegram.sendChatAction(ctx.chat.id, 'typing');
  const supportMsg = userState.usePidgin
    ? '🛠️ *Support*\n\nNeed help? Pick one:\n\n• How It Works\n• Transaction No Show\n• Contact Us'
    : '🛠️ *Support*\n\nNeed assistance? Choose an option:\n\n• How It Works\n• Transaction Not Received\n• Contact Us';
  const sentMessage = await ctx.replyWithMarkdown(supportMsg, Markup.inlineKeyboard([
    [Markup.button.callback('❓ How It Works', 'support_how_it_works')],
    [Markup.button.callback('⚠️ Transaction Not Received', 'support_not_received')],
    [Markup.button.callback('💬 Contact Us', 'support_contact')],
  ]));
  ctx.session.supportMessageId = sentMessage.message_id;
});

bot.action('support_how_it_works', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  await bot.telegram.sendChatAction(ctx.chat.id, 'typing');
  const howItWorksMsg = userState.usePidgin
    ? '📖 *How DirectPay Work*\n\n1. Generate wallet\n2. Link bank\n3. Send USDC/USDT\n4. Get Naira fast\n\nSimple as that!'
    : '📖 *How DirectPay Works*\n\n1. Generate a wallet\n2. Link your bank\n3. Send USDC/USDT\n4. Receive Naira quickly\n\nThat’s it!';
  if (ctx.session.supportMessageId) {
    await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.supportMessageId, null, howItWorksMsg, {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'support_back')]]).reply_markup,
    });
  } else {
    const sentMessage = await ctx.replyWithMarkdown(howItWorksMsg, Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'support_back')]]));
    ctx.session.supportMessageId = sentMessage.message_id;
  }
  ctx.answerCbQuery();
});

bot.action('support_not_received', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  await bot.telegram.sendChatAction(ctx.chat.id, 'typing');
  const notReceivedMsg = userState.usePidgin
    ? '⚠️ *Transaction No Show*\n\nSend your Ref ID to [@maxcswap](https://t.me/maxcswap). We go check am fast.'
    : '⚠️ *Transaction Not Received*\n\nPlease send your Reference ID to [@maxcswap](https://t.me/maxcswap). We’ll check it quickly.';
  if (ctx.session.supportMessageId) {
    await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.supportMessageId, null, notReceivedMsg, {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'support_back')]]).reply_markup,
    });
  } else {
    const sentMessage = await ctx.replyWithMarkdown(notReceivedMsg, Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'support_back')]]));
    ctx.session.supportMessageId = sentMessage.message_id;
  }
  ctx.answerCbQuery();
});

bot.action('support_contact', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  await bot.telegram.sendChatAction(ctx.chat.id, 'typing');
  const contactMsg = userState.usePidgin
    ? '💬 *Contact Us*\n\nReach us at [@maxcswap](https://t.me/maxcswap) for any wahala.'
    : '💬 *Contact Us*\n\nReach out to us at [@maxcswap](https://t.me/maxcswap) for any issues.';
  if (ctx.session.supportMessageId) {
    await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.supportMessageId, null, contactMsg, {
  parse_mode: 'Markdown',
  reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'support_back')]]).reply_markup,
});
  } else {
    const sentMessage = await ctx.replyWithMarkdown(contactMsg, Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'support_back')]]));
    ctx.session.supportMessageId = sentMessage.message_id;
  }
  ctx.answerCbQuery();
});

bot.action('support_back', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  await bot.telegram.sendChatAction(ctx.chat.id, 'typing');
  const supportMsg = userState.usePidgin
    ? '🛠️ *Support*\n\nNeed help? Pick one:\n\n• How It Works\n• Transaction No Show\n• Contact Us'
    : '🛠️ *Support*\n\nNeed assistance? Choose an option:\n\n• How It Works\n• Transaction Not Received\n• Contact Us';
  if (ctx.session.supportMessageId) {
    await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.supportMessageId, null, supportMsg, {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('❓ How It Works', 'support_how_it_works')],
        [Markup.button.callback('⚠️ Transaction Not Received', 'support_not_received')],
        [Markup.button.callback('💬 Contact Us', 'support_contact')],
      ]).reply_markup,
    });
  } else {
    const sentMessage = await ctx.replyWithMarkdown(supportMsg, Markup.inlineKeyboard([
      [Markup.button.callback('❓ How It Works', 'support_how_it_works')],
      [Markup.button.callback('⚠️ Transaction Not Received', 'support_not_received')],
      [Markup.button.callback('💬 Contact Us', 'support_contact')],
    ]));
    ctx.session.supportMessageId = sentMessage.message_id;
  }
  ctx.answerCbQuery();
});

// =================== Learn About Base Handler ===================
bot.hears('📘 Learn About Base', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  await bot.telegram.sendChatAction(ctx.chat.id, 'typing');
  const baseMsg = userState.usePidgin
    ? '📘 *About Base*\n\nBase na Ethereum L2 wey fast and cheap. E use Optimistic Rollups to make transactions quick and secure. You fit send USDC/USDT with small gas fees.\n\nLearn more: [base.org](https://base.org)'
    : '📘 *About Base*\n\nBase is an Ethereum Layer 2 solution that’s fast and cost-effective. It uses Optimistic Rollups for quick, secure transactions. Send USDC/USDT with low gas fees.\n\nLearn more: [base.org](https://base.org)';
  await ctx.replyWithMarkdown(baseMsg);
});

// =================== View Current Rates Handler ===================
bot.hears('📈 View Current Rates', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  await bot.telegram.sendChatAction(ctx.chat.id, 'typing');
  let ratesMsg = userState.usePidgin
    ? '📈 *Current Rates*\n\n'
    : '📈 *Current Exchange Rates*\n\n';
  for (const [asset, rate] of Object.entries(exchangeRates)) {
    ratesMsg += `• *${asset}*: ₦${rate.toFixed(2)}\n`;
  }
  ratesMsg += userState.usePidgin
    ? '\nThese rates dey update every 5 minutes.'
    : '\nRates are updated every 5 minutes.';
  await ctx.replyWithMarkdown(ratesMsg);
});

// =================== Settings Handler ===================
bot.hears('⚙️ Settings', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  await bot.telegram.sendChatAction(ctx.chat.id, 'typing');
  const settingsMsg = userState.usePidgin
    ? '⚙️ *Settings*\n\nPick one to manage your account:'
    : '⚙️ *Settings*\n\nChoose an option to manage your account:';
  const sentMessage = await ctx.replyWithMarkdown(settingsMsg, getSettingsMenu());
  ctx.session.settingsMessageId = sentMessage.message_id;
});

bot.action('settings_generate_wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  await bot.telegram.sendChatAction(ctx.chat.id, 'typing');
  if (userState.wallets.length >= MAX_WALLETS) {
    const errorMsg = userState.usePidgin
      ? `⚠️ You don reach max wallets (${MAX_WALLETS}). Check your wallets first.`
      : `⚠️ You’ve reached the maximum wallet limit (${MAX_WALLETS}). Check your existing wallets first.`;
    await ctx.replyWithMarkdown(errorMsg);
    ctx.answerCbQuery();
    return;
  }
  const prompt = userState.usePidgin
    ? '🔄 You sure say you wan generate new wallet?'
    : '🔄 Are you sure you want to generate a new wallet?';
  if (ctx.session.settingsMessageId) {
    await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.settingsMessageId, null, prompt, {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes', 'confirm_generate_wallet')],
        [Markup.button.callback('❌ No', 'settings_back_main')],
      ]).reply_markup,
    });
  } else {
    const sentMessage = await ctx.replyWithMarkdown(prompt, Markup.inlineKeyboard([
      [Markup.button.callback('✅ Yes', 'confirm_generate_wallet')],
      [Markup.button.callback('❌ No', 'settings_back_main')],
    ]));
    ctx.session.settingsMessageId = sentMessage.message_id;
  }
  ctx.answerCbQuery();
});

bot.action('confirm_generate_wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  await bot.telegram.sendChatAction(ctx.chat.id, 'typing');
  try {
    if (!limitWalletGeneration(userId)) {
      const errorMsg = userState.usePidgin
        ? '⚠️ You don try too many times. Wait small before you try again.'
        : '⚠️ Too many wallet generation attempts. Please wait before trying again.';
      await ctx.replyWithMarkdown(errorMsg);
      ctx.answerCbQuery();
      return;
    }

    const chain = 'Base';
    const generatingMessage = await ctx.replyWithMarkdown(
      userState.usePidgin ? `🔄 Generating wallet for ${chain}. Wait small...` : `🔄 Generating your wallet on ${chain}. Please wait...`
    );

    const wallet = await generateWallet(chain);
    userState.wallets.push({
      address: wallet.address,
      privateKey: wallet.privateKey,
      chain: chain,
      supportedAssets: chains[chain].supportedAssets,
      bank: null,
      amount: 0,
      creationDate: new Date().toISOString(),
      totalDeposits: 0,
      totalPayouts: 0,
    });
    userState.walletAddresses.push(wallet.address);

    await updateUserState(userId, {
      wallets: userState.wallets,
      walletAddresses: userState.wallets.map((w) => w.address),
    });

    await bot.telegram.sendMessage(
      PERSONAL_CHAT_ID,
      `💼 Wallet generated for user ${userId} on ${chain}: ${wallet.address}`,
      { parse_mode: 'Markdown' }
    );
    logger.info(`Wallet generated for user ${userId} on ${chain}: ${wallet.address}`);

    await ctx.deleteMessage(generatingMessage.message_id);

    const tempFilePath = path.join(__dirname, `temp_qr_${userId}_${Date.now()}.png`);
    const qrCodeData = await QRCode.toBuffer(wallet.address, { width: 200 });
    if (!fs.existsSync(WALLET_GENERATED_IMAGE)) {
      throw new Error(`Base image not found at ${WALLET_GENERATED_IMAGE}`);
    }

    await sharp(WALLET_GENERATED_IMAGE)
      .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
      .composite([{ input: qrCodeData, top: 250, left: 210 }])
      .png()
      .toFile(tempFilePath);

    const successMsg = userState.usePidgin
      ? `✅ *New Wallet Ready*\n\n` +
        `*Networks:* Base, BNB Smart Chain, Polygon (EVM Compatible)\n` +
        `*Assets:* USDC, USDT\n` +
        `*Address:* \`${wallet.address}\`\n\n` +
        `Link your bank to start using it.\n\n*Refund Address:* Set one in "⚙️ Settings" if payout fail (default na this wallet).`
      : `✅ *New Wallet Generated*\n\n` +
        `*Networks:* Base, BNB Smart Chain, Polygon (EVM Compatible)\n` +
        `*Assets:* USDC, USDT\n` +
        `*Address:* \`${wallet.address}\`\n\n` +
        `Link your bank to start using it.\n\n*Refund Address:* Set one in "⚙️ Settings" for failed payouts (defaults to this wallet).`;

    await ctx.replyWithPhoto(
      { source: createReadStream(tempFilePath) },
      {
        caption: successMsg,
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🏦 Link Bank Now', 'link_bank_now')]]),
      }
    );

    await unlinkAsync(tempFilePath);
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error generating wallet from settings for user ${userId}: ${error.message}`);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Something went wrong. Please try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    ctx.answerCbQuery();
  }
});

bot.action('settings_edit_bank', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  await bot.telegram.sendChatAction(ctx.chat.id, 'typing');
  if (userState.wallets.length === 0) {
    const errorMsg = userState.usePidgin
      ? '❌ No wallet dey. Generate one first.'
      : '❌ You have no wallets. Generate one first.';
    await ctx.replyWithMarkdown(errorMsg);
    ctx.answerCbQuery();
    return;
  }

  const walletButtons = userState.wallets.map((wallet, index) => [
    Markup.button.callback(
      `Wallet ${index + 1} - ${wallet.chain} (${wallet.name || 'Unnamed'})`,
      `edit_bank_wallet_${index}`
    ),
  ]);

  const prompt = userState.usePidgin
    ? '🏦 *Link or Edit Bank*\n\nPick wallet to link bank:'
    : '🏦 *Link or Edit Bank*\n\nSelect a wallet to link a bank account:';
  if (ctx.session.settingsMessageId) {
    await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.settingsMessageId, null, prompt, {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([...walletButtons, [Markup.button.callback('🔙 Back', 'settings_back_main')]]).reply_markup,
    });
  } else {
    const sentMessage = await ctx.replyWithMarkdown(prompt, Markup.inlineKeyboard([...walletButtons, [Markup.button.callback('🔙 Back', 'settings_back_main')]]));
    ctx.session.settingsMessageId = sentMessage.message_id;
  }
  ctx.answerCbQuery();
});

bot.action(/edit_bank_wallet_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);
  const userState = await getUserState(userId);
  await bot.telegram.sendChatAction(ctx.chat.id, 'typing');
  if (walletIndex >= userState.wallets.length) {
    const errorMsg = userState.usePidgin
      ? '❌ Wallet no dey. Pick another one.'
      : '❌ Invalid wallet. Please select another.';
    await ctx.replyWithMarkdown(errorMsg);
    ctx.answerCbQuery();
    return;
  }
  ctx.session.walletIndex = walletIndex;
  try {
    await ctx.scene.enter('bank_linking_scene');
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error entering bank_linking_scene for user ${userId}: ${error.message}`);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Something went wrong. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    ctx.answerCbQuery();
  }
});

bot.action('settings_rename_wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  await bot.telegram.sendChatAction(ctx.chat.id, 'typing');
  if (userState.wallets.length === 0) {
    const errorMsg = userState.usePidgin
      ? '❌ No wallet dey. Generate one first.'
      : '❌ You have no wallets. Generate one first.';
    await ctx.replyWithMarkdown(errorMsg);
    ctx.answerCbQuery();
    return;
  }

  const walletButtons = userState.wallets.map((wallet, index) => [
    Markup.button.callback(
      `Wallet ${index + 1} - ${wallet.chain} (${wallet.name || 'Unnamed'})`,
      `rename_wallet_${index}`
    ),
  ]);

  const prompt = userState.usePidgin
    ? '📝 *Rename Wallet*\n\nPick wallet to rename:'
    : '📝 *Rename Wallet*\n\nSelect a wallet to rename:';
  if (ctx.session.settingsMessageId) {
    await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.settingsMessageId, null, prompt, {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([...walletButtons, [Markup.button.callback('🔙 Back', 'settings_back_main')]]).reply_markup,
    });
  } else {
    const sentMessage = await ctx.replyWithMarkdown(prompt, Markup.inlineKeyboard([...walletButtons, [Markup.button.callback('🔙 Back', 'settings_back_main')]]));
    ctx.session.settingsMessageId = sentMessage.message_id;
  }
  ctx.answerCbQuery();
});

bot.action(/rename_wallet_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);
  const userState = await getUserState(userId);
  await bot.telegram.sendChatAction(ctx.chat.id, 'typing');
  if (walletIndex >= userState.wallets.length) {
    const errorMsg = userState.usePidgin
      ? '❌ Wallet no dey. Pick another one.'
      : '❌ Invalid wallet. Please select another.';
    await ctx.replyWithMarkdown(errorMsg);
    ctx.answerCbQuery();
    return;
  }
  ctx.session.renameWalletIndex = walletIndex;
  const prompt = userState.usePidgin
    ? `📝 Enter new name for Wallet ${walletIndex + 1} - ${userState.wallets[walletIndex].chain}:`
    : `📝 Enter a new name for Wallet ${walletIndex + 1} - ${userState.wallets[walletIndex].chain}:`;
  if (ctx.session.settingsMessageId) {
    await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.settingsMessageId, null, prompt, {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔙 Cancel', 'settings_back_main')]]).reply_markup,
    });
  } else {
    const sentMessage = await ctx.replyWithMarkdown(prompt, Markup.inlineKeyboard([[Markup.button.callback('🔙 Cancel', 'settings_back_main')]]));
    ctx.session.settingsMessageId = sentMessage.message_id;
  }
  ctx.session.awaitingRename = true;
  ctx.answerCbQuery();
});

bot.action('settings_set_refund_address', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  await bot.telegram.sendChatAction(ctx.chat.id, 'typing');
  const prompt = userState.usePidgin
    ? '🔄 *Set Refund Address*\n\nEnter address where we go send funds if payout fail (e.g., 0x123...):'
    : '🔄 *Set Refund Address*\n\nEnter the address where we should send funds if a payout fails (e.g., 0x123...):';
  if (ctx.session.settingsMessageId) {
    await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.settingsMessageId, null, prompt, {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔙 Cancel', 'settings_back_main')]]).reply_markup,
    });
  } else {
    const sentMessage = await ctx.replyWithMarkdown(prompt, Markup.inlineKeyboard([[Markup.button.callback('🔙 Cancel', 'settings_back_main')]]));
    ctx.session.settingsMessageId = sentMessage.message_id;
  }
  ctx.session.awaitingRefundAddress = true;
  ctx.answerCbQuery();
});

bot.action('settings_support', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  await bot.telegram.sendChatAction(ctx.chat.id, 'typing');
  const supportMsg = userState.usePidgin
    ? '💬 *Support*\n\nReach us at [@maxcswap](https://t.me/maxcswap) for any wahala.'
    : '💬 *Support*\n\nContact us at [@maxcswap](https://t.me/maxcswap) for any issues.';
  if (ctx.session.settingsMessageId) {
    await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.settingsMessageId, null, supportMsg, {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'settings_back_main')]]).reply_markup,
    });
  } else {
    const sentMessage = await ctx.replyWithMarkdown(supportMsg, Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'settings_back_main')]]));
    ctx.session.settingsMessageId = sentMessage.message_id;
  }
  ctx.answerCbQuery();
});

bot.action('settings_back_main', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  await bot.telegram.sendChatAction(ctx.chat.id, 'typing');
  const settingsMsg = userState.usePidgin
    ? '⚙️ *Settings*\n\nPick one to manage your account:'
    : '⚙️ *Settings*\n\nChoose an option to manage your account:';
  if (ctx.session.settingsMessageId) {
    await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.settingsMessageId, null, settingsMsg, {
      parse_mode: 'Markdown',
      reply_markup: getSettingsMenu().reply_markup,
    });
  } else {
    const sentMessage = await ctx.replyWithMarkdown(settingsMsg, getSettingsMenu());
    ctx.session.settingsMessageId = sentMessage.message_id;
  }
  delete ctx.session.awaitingRename;
  delete ctx.session.awaitingRefundAddress;
  ctx.answerCbQuery();
});

// =================== Admin Panel Handlers ===================
bot.action('open_admin_panel', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    await ctx.answerCbQuery('❌ Unauthorized access.', { show_alert: true });
    return;
  }
  const userState = await getUserState(userId);
  await bot.telegram.sendChatAction(ctx.chat.id, 'typing');
  const adminMsg = userState.usePidgin
    ? '🔧 *Admin Panel*\n\nPick one to manage:'
    : '🔧 *Admin Panel*\n\nChoose an option to manage:';
  if (ctx.session.adminMessageId) {
    await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.adminMessageId, null, adminMsg, {
      parse_mode: 'Markdown',
      reply_markup: getAdminMenu().reply_markup,
    });
  } else {
    const sentMessage = await ctx.replyWithMarkdown(adminMsg, getAdminMenu());
    ctx.session.adminMessageId = sentMessage.message_id;
  }
  ctx.answerCbQuery();
});

bot.action('admin_view_all_transactions', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    await ctx.answerCbQuery('❌ Unauthorized access.', { show_alert: true });
    return;
  }
  const userState = await getUserState(userId);
  await bot.telegram.sendChatAction(ctx.chat.id, 'typing');
  try {
    const transactionsSnapshot = await db.collection('transactions').orderBy('timestamp', 'desc').limit(10).get();
    let message = userState.usePidgin
      ? '📋 *All Transactions*\n\n'
      : '📋 *All Transactions*\n\n';
    if (transactionsSnapshot.empty) {
      message += userState.usePidgin ? 'No transactions yet.' : 'No transactions found yet.';
    } else {
      transactionsSnapshot.forEach((doc) => {
        const tx = doc.data();
        message += userState.usePidgin
          ? `*User:* ${tx.userId}\n` +
            `• *Ref ID:* \`${tx.referenceId || 'N/A'}\`\n` +
            `• *Asset:* ${tx.asset || 'N/A'}\n` +
            `• *Amount:* ${tx.amount || 'N/A'}\n` +
            `• *Status:* ${tx.status || 'Pending'}\n` +
            `• *Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleDateString() : 'N/A'}\n\n`
          : `*User ID:* ${tx.userId}\n` +
            `• *Reference ID:* \`${tx.referenceId || 'N/A'}\`\n` +
            `• *Asset:* ${tx.asset || 'N/A'}\n` +
            `• *Amount:* ${tx.amount || 'N/A'}\n` +
            `• *Status:* ${tx.status || 'Pending'}\n` +
            `• *Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleDateString() : 'N/A'}\n\n`;
      });
    }
    if (ctx.session.adminMessageId) {
      await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.adminMessageId, null, message, {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'admin_back_to_main')]]).reply_markup,
      });
    } else {
      const sentMessage = await ctx.replyWithMarkdown(message, Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'admin_back_to_main')]]));
      ctx.session.adminMessageId = sentMessage.message_id;
    }
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error viewing all transactions for admin ${userId}: ${error.message}`);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Error occurred. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    ctx.answerCbQuery();
  }
});

bot.action('admin_view_users', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    await ctx.answerCbQuery('❌ Unauthorized access.', { show_alert: true });
    return;
  }
  const userState = await getUserState(userId);
  await bot.telegram.sendChatAction(ctx.chat.id, 'typing');
  try {
    const usersSnapshot = await db.collection('users').limit(10).get();
    let message = userState.usePidgin
      ? '👥 *All Users*\n\n'
      : '👥 *All Users*\n\n';
    if (usersSnapshot.empty) {
      message += userState.usePidgin ? 'No users yet.' : 'No users found yet.';
    } else {
      usersSnapshot.forEach((doc) => {
        const user = doc.data();
        message += userState.usePidgin
          ? `*User ID:* ${doc.id}\n` +
            `• *Name:* ${user.firstName || 'N/A'}\n` +
            `• *Wallets:* ${user.wallets?.length || 0}\n` +
            `• *Last Active:* ${user.lastInteraction ? new Date(user.lastInteraction).toLocaleDateString() : 'N/A'}\n\n`
          : `*User ID:* ${doc.id}\n` +
            `• *Name:* ${user.firstName || 'N/A'}\n` +
            `• *Wallets:* ${user.wallets?.length || 0}\n` +
            `• *Last Active:* ${user.lastInteraction ? new Date(user.lastInteraction).toLocaleDateString() : 'N/A'}\n\n`;
      });
    }
    if (ctx.session.adminMessageId) {
      await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.adminMessageId, null, message, {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'admin_back_to_main')]]).reply_markup,
      });
    } else {
      const sentMessage = await ctx.replyWithMarkdown(message, Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'admin_back_to_main')]]));
      ctx.session.adminMessageId = sentMessage.message_id;
    }
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error viewing users for admin ${userId}: ${error.message}`);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Error occurred. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    ctx.answerCbQuery();
  }
});

bot.action('admin_pending_issues', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    await ctx.answerCbQuery('❌ Unauthorized access.', { show_alert: true });
    return;
  }
  const userState = await getUserState(userId);
  await bot.telegram.sendChatAction(ctx.chat.id, 'typing');
  try {
    const pendingTxSnapshot = await db.collection('transactions').where('status', '==', 'Pending').limit(10).get();
    let message = userState.usePidgin
      ? '⏳ *Pending Issues*\n\n'
      : '⏳ *Pending Issues*\n\n';
    if (pendingTxSnapshot.empty) {
      message += userState.usePidgin ? 'No pending issues.' : 'No pending issues found.';
    } else {
      pendingTxSnapshot.forEach((doc) => {
        const tx = doc.data();
        message += userState.usePidgin
          ? `*User:* ${tx.userId}\n` +
            `• *Ref ID:* \`${tx.referenceId || 'N/A'}\`\n` +
            `• *Asset:* ${tx.asset || 'N/A'}\n` +
            `• *Amount:* ${tx.amount || 'N/A'}\n` +
            `• *Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleDateString() : 'N/A'}\n\n`
          : `*User ID:* ${tx.userId}\n` +
            `• *Reference ID:* \`${tx.referenceId || 'N/A'}\`\n` +
            `• *Asset:* ${tx.asset || 'N/A'}\n` +
            `• *Amount:* ${tx.amount || 'N/A'}\n` +
            `• *Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleDateString() : 'N/A'}\n\n`;
      });
    }
    if (ctx.session.adminMessageId) {
      await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.adminMessageId, null, message, {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'admin_back_to_main')]]).reply_markup,
      });
    } else {
      const sentMessage = await ctx.replyWithMarkdown(message, Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'admin_back_to_main')]]));
      ctx.session.adminMessageId = sentMessage.message_id;
    }
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error viewing pending issues for admin ${userId}: ${error.message}`);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Error occurred. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    ctx.answerCbQuery();
  }
});

bot.action('admin_send_message', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    await ctx.answerCbQuery('❌ Unauthorized access.', { show_alert: true });
    return;
  }
  const userState = await getUserState(userId);
  await bot.telegram.sendChatAction(ctx.chat.id, 'typing');
  try {
    await ctx.scene.enter('send_message_scene');
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error entering send_message_scene for admin ${userId}: ${error.message}`);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Error occurred. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    ctx.answerCbQuery();
  }
});

bot.action('admin_manual_payout', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    await ctx.answerCbQuery('❌ Unauthorized access.', { show_alert: true });
    return;
  }
  const userState = await getUserState(userId);
  await bot.telegram.sendChatAction(ctx.chat.id, 'typing');
  const prompt = userState.usePidgin
    ? '💰 *Manual Payout*\n\nEnter User ID, Amount, and Bank Details (Bank Name, Account Number, Account Name):'
    : '💰 *Manual Payout*\n\nEnter the User ID, Amount, and Bank Details (Bank Name, Account Number, Account Name):';
  if (ctx.session.adminMessageId) {
    await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.adminMessageId, null, prompt, {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔙 Cancel', 'admin_back_to_main')]]).reply_markup,
    });
  } else {
    const sentMessage = await ctx.replyWithMarkdown(prompt, Markup.inlineKeyboard([[Markup.button.callback('🔙 Cancel', 'admin_back_to_main')]]));
    ctx.session.adminMessageId = sentMessage.message_id;
  }
  ctx.session.awaitingManualPayout = true;
  ctx.answerCbQuery();
});

bot.action('admin_refund_tx', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    await ctx.answerCbQuery('❌ Unauthorized access.', { show_alert: true });
    return;
  }
  const userState = await getUserState(userId);
  await bot.telegram.sendChatAction(ctx.chat.id, 'typing');
  const prompt = userState.usePidgin
    ? '🔄 *Refund Transaction*\n\nEnter Ref ID and Refund Address:'
    : '🔄 *Refund Transaction*\n\nEnter the Reference ID and Refund Address:';
  if (ctx.session.adminMessageId) {
    await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.adminMessageId, null, prompt, {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔙 Cancel', 'admin_back_to_main')]]).reply_markup,
    });
  } else {
    const sentMessage = await ctx.replyWithMarkdown(prompt, Markup.inlineKeyboard([[Markup.button.callback('🔙 Cancel', 'admin_back_to_main')]]));
    ctx.session.adminMessageId = sentMessage.message_id;
  }
  ctx.session.awaitingRefundTx = true;
  ctx.answerCbQuery();
});

bot.action('admin_api_status', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    await ctx.answerCbQuery('❌ Unauthorized access.', { show_alert: true });
    return;
  }
  const userState = await getUserState(userId);
  await bot.telegram.sendChatAction(ctx.chat.id, 'typing');
  try {
    const statusMsg = userState.usePidgin
      ? '⚠️ *API/Bot Status*\n\n' +
        `• *Bot:* Online\n` +
        `• *Paycrest API:* ${exchangeRates.USDC > 0 ? 'Online' : 'Offline'}\n` +
        `• *Blockradar API:* ${chains['Base'].key ? 'Online' : 'Offline'}\n` +
        `• *Paystack API:* ${PAYSTACK_API_KEY ? 'Online' : 'Offline'}\n`
      : '⚠️ *API/Bot Status*\n\n' +
        `• *Bot:* Online\n` +
        `• *Paycrest API:* ${exchangeRates.USDC > 0 ? 'Online' : 'Offline'}\n` +
        `• *Blockradar API:* ${chains['Base'].key ? 'Online' : 'Offline'}\n` +
        `• *Paystack API:* ${PAYSTACK_API_KEY ? 'Online' : 'Offline'}\n`;
    if (ctx.session.adminMessageId) {
      await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.adminMessageId, null, statusMsg, {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'admin_back_to_main')]]).reply_markup,
      });
    } else {
      const sentMessage = await ctx.replyWithMarkdown(statusMsg, Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'admin_back_to_main')]]));
      ctx.session.adminMessageId = sentMessage.message_id;
    }
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error checking API status for admin ${userId}: ${error.message}`);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Error occurred. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    ctx.answerCbQuery();
  }
});

bot.action('admin_back_to_main', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    await ctx.answerCbQuery('❌ Unauthorized access.', { show_alert: true });
    return;
  }
  const userState = await getUserState(userId);
  await bot.telegram.sendChatAction(ctx.chat.id, 'typing');
  const adminMsg = userState.usePidgin
    ? '🔧 *Admin Panel*\n\nPick one to manage:'
    : '🔧 *Admin Panel*\n\nChoose an option to manage:';
  if (ctx.session.adminMessageId) {
    await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.adminMessageId, null, adminMsg, {
      parse_mode: 'Markdown',
      reply_markup: getAdminMenu().reply_markup,
    });
  } else {
    const sentMessage = await ctx.replyWithMarkdown(adminMsg, getAdminMenu());
    ctx.session.adminMessageId = sentMessage.message_id;
  }
  delete ctx.session.awaitingManualPayout;
  delete ctx.session.awaitingRefundTx;
  ctx.answerCbQuery();
});

// =================== Text Handlers for Settings Inputs ===================
bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const text = sanitizeInput(ctx.message.text.trim());

  if (ctx.session.awaitingRename) {
    await bot.telegram.sendChatAction(ctx.chat.id, 'typing');
    const walletIndex = ctx.session.renameWalletIndex;
    if (walletIndex >= userState.wallets.length) {
      const errorMsg = userState.usePidgin
        ? '❌ Wallet no dey. Try again.'
        : '❌ Invalid wallet. Try again.';
      await ctx.replyWithMarkdown(errorMsg);
      delete ctx.session.awaitingRename;
      return;
    }
    if (text.length > 50) {
      const errorMsg = userState.usePidgin
        ? '❌ Name too long. Keep am under 50 characters.'
        : '❌ Name too long. Keep it under 50 characters.';
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }
    userState.wallets[walletIndex].name = text;
    await updateUserState(userId, { wallets: userState.wallets });
    const successMsg = userState.usePidgin
      ? `✅ Wallet ${walletIndex + 1} don rename to "${text}".`
      : `✅ Wallet ${walletIndex + 1} renamed to "${text}".`;
    await ctx.replyWithMarkdown(successMsg);
    delete ctx.session.awaitingRename;
    delete ctx.session.renameWalletIndex;
    const settingsMsg = userState.usePidgin
      ? '⚙️ *Settings*\n\nPick one to manage your account:'
      : '⚙️ *Settings*\n\nChoose an option to manage your account:';
    if (ctx.session.settingsMessageId) {
      await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.settingsMessageId, null, settingsMsg, {
        parse_mode: 'Markdown',
        reply_markup: getSettingsMenu().reply_markup,
      });
    } else {
      const sentMessage = await ctx.replyWithMarkdown(settingsMsg, getSettingsMenu());
      ctx.session.settingsMessageId = sentMessage.message_id;
    }
    return;
  }

  if (ctx.session.awaitingRefundAddress) {
    await bot.telegram.sendChatAction(ctx.chat.id, 'typing');
    if (!ethers.isAddress(text)) {
      const errorMsg = userState.usePidgin
        ? '❌ Address no correct. Enter valid Ethereum address (e.g., 0x123...).'
        : '❌ Invalid address. Please enter a valid Ethereum address (e.g., 0x123...).';
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }
    await updateUserState(userId, { refundAddress: text });
    const successMsg = userState.usePidgin
      ? `✅ Refund address set to \`${text}\`.`
      : `✅ Refund address set to \`${text}\`.`;
    await ctx.replyWithMarkdown(successMsg);
    delete ctx.session.awaitingRefundAddress;
    const settingsMsg = userState.usePidgin
      ? '⚙️ *Settings*\n\nPick one to manage your account:'
      : '⚙️ *Settings*\n\nChoose an option to manage your account:';
    if (ctx.session.settingsMessageId) {
      await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.settingsMessageId, null, settingsMsg, {
        parse_mode: 'Markdown',
        reply_markup: getSettingsMenu().reply_markup,
      });
    } else {
      const sentMessage = await ctx.replyWithMarkdown(settingsMsg, getSettingsMenu());
      ctx.session.settingsMessageId = sentMessage.message_id;
    }
    return;
  }

  if (ctx.session.awaitingManualPayout && isAdmin(userId)) {
    await bot.telegram.sendChatAction(ctx.chat.id, 'typing');
    const parts = text.split(',').map((p) => p.trim());
    if (parts.length < 4) {
      const errorMsg = userState.usePidgin
        ? '❌ Format no correct. Use: User ID, Amount, Bank Name, Account Number, Account Name'
        : '❌ Incorrect format. Use: User ID, Amount, Bank Name, Account Number, Account Name';
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }
    const [targetUserId, amountStr, bankName, accountNumber, accountName] = parts;
    const amount = parseFloat(amountStr);
    if (isNaN(amount) || amount <= 0) {
      const errorMsg = userState.usePidgin
        ? '❌ Amount no valid. Enter correct number.'
        : '❌ Invalid amount. Please enter a valid number.';
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }
    const bank = bankList.find((b) => b.name.toLowerCase() === bankName.toLowerCase());
    if (!bank) {
      const errorMsg = userState.usePidgin
        ? '❌ Bank no dey list. Check and try again.'
        : '❌ Bank not found. Please check and try again.';
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }
    if (!/^\d{10}$/.test(accountNumber)) {
      const errorMsg = userState.usePidgin
        ? '❌ Account number must be 10 digits.'
        : '❌ Account number must be 10 digits.';
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }
    try {
      const verificationResult = await verifyBankAccount(accountNumber, bank.code);
      if (!verificationResult.data.account_name) {
        throw new Error('Account verification failed.');
      }
      // Simulate manual payout (replace with actual payout logic)
      const referenceId = generateReferenceId();
      await db.collection('transactions').doc(referenceId).set({
        userId: targetUserId,
        referenceId,
        amount,
        asset: 'NGN',
        payout: amount,
        status: 'Completed',
        timestamp: new Date().toISOString(),
        bankDetails: {
          bankName: bank.name,
          accountNumber,
          accountName: verificationResult.data.account_name,
        },
      });
      await bot.telegram.sendMessage(
        targetUserId,
        userState.usePidgin
          ? `✅ *Payout Done*\n\nYou don receive ₦${amount} to your ${bank.name} account (****${accountNumber.slice(-4)}). Ref ID: \`${referenceId}\`.`
          : `✅ *Payout Completed*\n\nYou’ve received ₦${amount} to your ${bank.name} account (****${accountNumber.slice(-4)}). Reference ID: \`${referenceId}\`.`,
        { parse_mode: 'Markdown' }
      );
      const successMsg = userState.usePidgin
        ? `✅ Payout of ₦${amount} sent to user ${targetUserId} (${bank.name}, ****${accountNumber.slice(-4)}).`
        : `✅ Payout of ₦${amount} sent to user ${targetUserId} (${bank.name}, ****${accountNumber.slice(-4)}).`;
      await ctx.replyWithMarkdown(successMsg);
      delete ctx.session.awaitingManualPayout;
      const adminMsg = userState.usePidgin
        ? '🔧 *Admin Panel*\n\nPick one to manage:'
        : '🔧 *Admin Panel*\n\nChoose an option to manage:';
      if (ctx.session.adminMessageId) {
        await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.adminMessageId, null, adminMsg, {
          parse_mode: 'Markdown',
          reply_markup: getAdminMenu().reply_markup,
        });
      } else {
        const sentMessage = await ctx.replyWithMarkdown(adminMsg, getAdminMenu());
        ctx.session.adminMessageId = sentMessage.message_id;
      }
    } catch (error) {
      logger.error(`Error processing manual payout for admin ${userId}: ${error.message}`);
      const errorMsg = userState.usePidgin
        ? '❌ Payout no work. Check details and try again.'
        : '❌ Payout failed. Check details and try again.';
      await ctx.replyWithMarkdown(errorMsg);
    }
    return;
  }

  if (ctx.session.awaitingRefundTx && isAdmin(userId)) {
    await bot.telegram.sendChatAction(ctx.chat.id, 'typing');
    const parts = text.split(',').map((p) => p.trim());
    if (parts.length < 2) {
      const errorMsg = userState.usePidgin
        ? '❌ Format no correct. Use: Ref ID, Refund Address'
        : '❌ Incorrect format. Use: Reference ID, Refund Address';
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }
    const [refId, refundAddress] = parts;
    if (!ethers.isAddress(refundAddress)) {
      const errorMsg = userState.usePidgin
        ? '❌ Refund address no correct. Enter valid Ethereum address.'
        : '❌ Invalid refund address. Please enter a valid Ethereum address.';
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }
    try {
      const txDoc = await db.collection('transactions').doc(refId).get();
      if (!txDoc.exists) {
        const errorMsg = userState.usePidgin
          ? '❌ Ref ID no dey. Check am again.'
          : '❌ Reference ID not found. Please check and try again.';
        await ctx.replyWithMarkdown(errorMsg);
        return;
      }
      const tx = txDoc.data();
      if (tx.status === 'Refunded') {
        const errorMsg = userState.usePidgin
          ? '❌ This transaction don already refund.'
          : '❌ This transaction has already been refunded.';
        await ctx.replyWithMarkdown(errorMsg);
        return;
      }
      // Simulate refund (replace with actual refund logic)
      await db.collection('transactions').doc(refId).update({
        status: 'Refunded',
        refundAddress,
        refundTimestamp: new Date().toISOString(),
      });
      await bot.telegram.sendMessage(
        tx.userId,
        userState.usePidgin
          ? `🔄 *Refund Done*\n\nYour transaction (\`${refId}\`) don refund to \`${refundAddress}\`.`
          : `🔄 *Refund Completed*\n\nYour transaction (\`${refId}\`) has been refunded to \`${refundAddress}\`.`,
        { parse_mode: 'Markdown' }
      );
      const successMsg = userState.usePidgin
        ? `✅ Refund for \`${refId}\` sent to \`${refundAddress}\`.`
        : `✅ Refund for \`${refId}\` sent to \`${refundAddress}\`.`;
      await ctx.replyWithMarkdown(successMsg);
      delete ctx.session.awaitingRefundTx;
      const adminMsg = userState.usePidgin
        ? '🔧 *Admin Panel*\n\nPick one to manage:'
        : '🔧 *Admin Panel*\n\nChoose an option to manage:';
      if (ctx.session.adminMessageId) {
        await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.adminMessageId, null, adminMsg, {
          parse_mode: 'Markdown',
          reply_markup: getAdminMenu().reply_markup,
        });
      } else {
        const sentMessage = await ctx.replyWithMarkdown(adminMsg, getAdminMenu());
        ctx.session.adminMessageId = sentMessage.message_id;
      }
    } catch (error) {
      logger.error(`Error processing refund for admin ${userId}: ${error.message}`);
      const errorMsg = userState.usePidgin
        ? '❌ Refund no work. Check details and try again.'
        : '❌ Refund failed. Check details and try again.';
      await ctx.replyWithMarkdown(errorMsg);
    }
    return;
  }

  if (text.toLowerCase() === 'pidgin') {
    await bot.telegram.sendChatAction(ctx.chat.id, 'typing');
    await updateUserState(userId, { usePidgin: true });
    const successMsg = '✅ Switched to Pidgin! How I fit help you now?';
    await ctx.replyWithMarkdown(successMsg, getMainMenu(userState.wallets.length > 0, userState.wallets.some((w) => w.bank)));
    return;
  }

  // Default response for unrecognized text
  const defaultMsg = userState.usePidgin
    ? '🤔 I no sure wetin you mean. Try menu below or type /help.'
    : '🤔 I’m not sure what you mean. Use the menu below or type /help.';
  await ctx.replyWithMarkdown(defaultMsg, getMainMenu(userState.wallets.length > 0, userState.wallets.some((w) => w.bank)));
});

// =================== Paycrest Webhook Handler ===================
async function handlePaycrestWebhook(req, res) {
  const userId = req.headers['x-user-id'] || 'unknown';
  const userState = await getUserState(userId);
  try {
    const signature = req.headers['x-paycrest-signature'];
    if (!signature) {
      logger.error('Paycrest webhook: Missing signature');
      return res.status(401).json({ error: 'Missing signature' });
    }

    const rawBody = req.body.toString();
    if (!verifyPaycrestSignature(rawBody, signature, PAYCREST_CLIENT_SECRET)) {
      logger.error('Paycrest webhook: Invalid signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const payload = JSON.parse(rawBody);
    const { event, data } = payload;

    if (!event || !data) {
      logger.error('Paycrest webhook: Invalid payload structure');
      return res.status(400).json({ error: 'Invalid payload' });
    }

    logger.info(`Paycrest webhook received: ${event}`);

    switch (event) {
      case 'order.created': {
        const { orderId, amount, token, network, status } = data;
        const txRef = generateReferenceId();
        await db.collection('transactions').doc(txRef).set({
          userId,
          referenceId: txRef,
          orderId,
          amount: parseFloat(amount),
          asset: token,
          chain: network,
          status: 'Pending',
          timestamp: new Date().toISOString(),
        });
        const msg = userState.usePidgin
          ? `🔔 *New Order*\n\nOrder \`${txRef}\` created for ${amount} ${token} on ${network}. We dey process am!`
          : `🔔 *New Order*\n\nOrder \`${txRef}\` created for ${amount} ${token} on ${network}. We’re processing it!`;
        await bot.telegram.sendMessage(userId, msg, { parse_mode: 'Markdown' });
        break;
      }
      case 'order.completed': {
        const { orderId, amount, token, network, transactionHash } = data;
        const txDoc = await db
          .collection('transactions')
          .where('orderId', '==', orderId)
          .where('userId', '==', userId)
          .limit(1)
          .get();
        if (txDoc.empty) {
          logger.error(`No transaction found for order ${orderId}`);
          return res.status(404).json({ error: 'Transaction not found' });
        }
        const doc = txDoc.docs[0];
        const txData = doc.data();
        const payout = calculatePayout(token, amount);
        await db.collection('transactions').doc(doc.id).update({
          status: 'Completed',
          payout,
          transactionHash,
          completionTimestamp: new Date().toISOString(),
        });
        const userState = await getUserState(userId);
        const walletIndex = userState.wallets.findIndex((w) => w.address === txData.walletAddress);
        if (walletIndex !== -1) {
          userState.wallets[walletIndex].totalPayouts = (userState.wallets[walletIndex].totalPayouts || 0) + payout;
          await updateUserState(userId, { wallets: userState.wallets });
        }
        const msg = userState.usePidgin
          ? `✅ *Payout Done*\n\nYou don receive ₦${payout} for ${amount} ${token} (Ref: \`${doc.id}\`). Check your bank!`
          : `✅ *Payout Completed*\n\nYou’ve received ₦${payout} for ${amount} ${token} (Ref: \`${doc.id}\`). Check your bank!`;
        await bot.telegram.sendMessage(userId, msg, { parse_mode: 'Markdown' });
        await bot.telegram.sendMessage(
          PERSONAL_CHAT_ID,
          `✅ Payout completed for user ${userId}: ₦${payout} for ${amount} ${token} (Ref: ${doc.id})`,
          { parse_mode: 'Markdown' }
        );
        break;
      }
      case 'order.failed': {
        const { orderId, reason } = data;
        const txDoc = await db
          .collection('transactions')
          .where('orderId', '==', orderId)
          .where('userId', '==', userId)
          .limit(1)
          .get();
        if (txDoc.empty) {
          logger.error(`No transaction found for order ${orderId}`);
          return res.status(404).json({ error: 'Transaction not found' });
        }
        const doc = txDoc.docs[0];
        const txData = doc.data();
        await db.collection('transactions').doc(doc.id).update({
          status: 'Failed',
          failureReason: reason || 'Unknown error',
          failureTimestamp: new Date().toISOString(),
        });
        const refundAddress = userState.refundAddress || txData.walletAddress;
        if (refundAddress) {
          // Simulate refund (replace with actual refund logic)
          await db.collection('transactions').doc(doc.id).update({
            status: 'Refunded',
            refundAddress,
            refundTimestamp: new Date().toISOString(),
          });
          const msg = userState.usePidgin
            ? `❌ *Order Fail*\n\nOrder \`${doc.id}\` no work (${reason || 'unknown error'}). We don refund your ${txData.amount} ${txData.asset} to \`${refundAddress}\`.`
            : `❌ *Order Failed*\n\nOrder \`${doc.id}\` failed (${reason || 'unknown error'}). We’ve refunded your ${txData.amount} ${txData.asset} to \`${refundAddress}\`.`;
          await bot.telegram.sendMessage(userId, msg, { parse_mode: 'Markdown' });
          await bot.telegram.sendMessage(
            PERSONAL_CHAT_ID,
            `❗️ Order ${doc.id} failed for user ${userId}: ${reason || 'unknown error'}. Refunded to ${refundAddress}`,
            { parse_mode: 'Markdown' }
          );
        } else {
          const msg = userState.usePidgin
            ? `❌ *Order Fail*\n\nOrder \`${doc.id}\` no work (${reason || 'unknown error'}). Set refund address in "⚙️ Settings" to get your funds back.`
            : `❌ *Order Failed*\n\nOrder \`${doc.id}\` failed (${reason || 'unknown error'}). Please set a refund address in "⚙️ Settings" to receive your funds.`;
          await bot.telegram.sendMessage(userId, msg, { parse_mode: 'Markdown' });
          await bot.telegram.sendMessage(
            PERSONAL_CHAT_ID,
            `❗️ Order ${doc.id} failed for user ${userId}: ${reason || 'unknown error'}. No refund address set.`,
            { parse_mode: 'Markdown' }
          );
        }
        break;
      }
      default:
        logger.warn(`Unhandled Paycrest webhook event: ${event}`);
    }

    res.status(200).json({ status: 'success' });
  } catch (error) {
    logger.error(`Error handling Paycrest webhook: ${error.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// =================== Error Handling ===================
bot.catch((err, ctx) => {
  logger.error(`Bot error: ${err.message}`, { stack: err.stack });
  const userId = ctx.from?.id?.toString() || 'unknown';
  getUserState(userId).then((userState) => {
    const errorMsg = userState.usePidgin
      ? '❌ E get small wahala. Try again later or contact [@maxcswap](https://t.me/maxcswap).'
      : '❌ Something went wrong. Try again later or contact [@maxcswap](https://t.me/maxcswap).';
    ctx.replyWithMarkdown(errorMsg);
  });
});

// =================== Start Express Server ===================
app.listen(PORT, () => {
  logger.info(`Express server running on port ${PORT}`);
});



// the end (na grant remain😂)
