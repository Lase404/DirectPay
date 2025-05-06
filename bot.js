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
require('dotenv').config();

// Initialize Logging
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

// Firebase Setup
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
  BLOCKRADAR_SOLANA_API_KEY,
  MAX_WALLETS = 5,
} = process.env;

if (!TELEGRAM_BOT_TOKEN || !PAYCREST_API_KEY || !PAYCREST_CLIENT_SECRET || !WEBHOOK_DOMAIN || !PAYSTACK_API_KEY || !BLOCKRADAR_SOLANA_API_KEY) {
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

// Validate PAYCREST_RETURN_ADDRESS
if (!ethers.utils.isAddress(PAYCREST_RETURN_ADDRESS)) {
  logger.error('Invalid PAYCREST_RETURN_ADDRESS. Must be a valid EVM address.');
  process.exit(1);
}

const WALLET_GENERATED_IMAGE = './wallet_generated_base1.png';
const DEPOSIT_SUCCESS_IMAGE = './deposit_success.png';
const PAYOUT_SUCCESS_IMAGE = './payout_success.png';
const ERROR_IMAGE = './error.png';

// Initialize Express and Telegraf
const app = express();
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// Define Supported Banks
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

// Define Supported Chains
const chains = {
  Base: {
    id: 'e31c44d6-0344-4ee1-bcd1-c88e89a9e3f1',
    key: BLOCKRADAR_BASE_API_KEY,
    apiUrl: 'https://api.blockradar.co/v1/wallets/e31c44d6-0344-4ee1-bcd1-c88e89a9e3f1/addresses',
    supportedAssets: ['USDC', 'USDT'],
    network: 'Base',
    assets: { USDC: 'a8aae94e-a2c3-424c-8db5-ea7415166ce3', USDT: 'a8aae94e-a2c3-424c-8db5-ea7415166ce3' },
    explorer: 'https://basescan.org/tx/'
  },
  Polygon: {
    id: 'f4fc4dc4-a0d5-4303-a60b-e58ec1fc6d0a',
    key: BLOCKRADAR_POLYGON_API_KEY,
    apiUrl: 'https://api.blockradar.co/v1/wallets/f4fc4dc4-a0d5-4303-a60b-e58ec1fc6d0a/addresses',
    supportedAssets: ['USDC', 'USDT'],
    network: 'Polygon',
    assets: { USDC: 'f348e8e3-e0b4-4704-857e-c274ef000c00', USDT: 'c9d57a33-375b-46f7-b694-16e9b498e0e1' },
    explorer: 'https://polygonscan.com/tx/'
  },
  'BNB Smart Chain': {
    id: '7a844e91-5740-4589-9695-c74411adec7e',
    key: BLOCKRADAR_BNB_API_KEY,
    apiUrl: 'https://api.blockradar.co/v1/wallets/7a844e91-5740-4589-9695-c74411adec7e/addresses',
    supportedAssets: ['USDT', 'USDC'],
    network: 'BNB Smart Chain',
    assets: { USDC: 'ff479231-0dbb-4760-b695-e219a50934af', USDT: '03a11a51-1422-4ac0-abc0-b2fed75e9fcb' },
    explorer: 'https://bscscan.com/tx/'
  },
  Solana: {
    id: '84a2a32e-32cf-43ba-a079-5b7fd1531c51',
    key: BLOCKRADAR_SOLANA_API_KEY,
    apiUrl: 'https://api.blockradar.co/v1/wallets/84a2a32e-32cf-43ba-a079-5b7fd1531c51/addresses',
    supportedAssets: ['USDC', 'USDT'],
    network: 'Solana',
    assets: {
      USDC: '4a493eb7-e307-4820-9f17-40fc17a87b15',
      USDT: '2f85ef3b-31bf-4a1c-b44a-74c57e32d21f'
    },
    explorer: 'https://solscan.io/tx/'
  }
};

// Chain Mapping
const chainMapping = {
  'base': 'Base',
  'polygon': 'Polygon',
  'bnb smart chain': 'BNB Smart Chain',
  'bnb smartchain': 'BNB Smart Chain',
  'bnb chain': 'BNB Smart Chain',
  'bnb': 'BNB Smart Chain',
  'solana': 'Solana'
};

// Solana Token Configurations
const SOLANA_TOKENS = {
  USDC: {
    address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    symbol: 'USDC',
    decimals: 6
  },
  USDT: {
    address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    symbol: 'USDT',
    decimals: 6
  }
};

// Constants
const SUPPORTED_ASSETS = ['USDC', 'USDT'];
let exchangeRates = { USDC: 1500, USDT: 1495 };

// Helper Functions
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
  else if (/solana/i.test(chainKey)) network = 'base'; // Solana deposits are bridged to Base
  else return null;
  return { token, network };
}

function calculatePayout(asset, amount) {
  const rate = exchangeRates[asset];
  if (!rate) throw new Error(`Unsupported asset received: ${asset}`);
  return parseFloat((amount * rate).toFixed(2));
}

function generateReferenceId() {
  return 'REF-' + crypto.randomBytes(8).toString('hex').toUpperCase();
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
    logger.error(`Error creating Paycrest order for user ${userId}: ${err.message}`);
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
        refundAddress: null
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
      refundAddress: data.refundAddress || null
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
      refundAddress: null
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

async function generateQRCodeImage(address, baseImagePath, outputPath) {
  try {
    const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(address)}`;
    const qrResponse = await axios.get(qrCodeUrl, { responseType: 'arraybuffer' });
    const qrCodeBuffer = Buffer.from(qrResponse.data);
    await sharp(baseImagePath)
      .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
      .composite([{ input: qrCodeBuffer, top: 250, left: 210 }])
      .png()
      .toFile(outputPath);
  } catch (error) {
    logger.error(`Error generating QR code image for address ${address}: ${error.message}`);
    throw error;
  }
}

async function cleanupOldQrCodes(userId, newQrPaths) {
  try {
    const userState = await getUserState(userId);
    for (const wallet of userState.wallets) {
      if (wallet.evmQrPath && !newQrPaths.includes(wallet.evmQrPath)) {
        try {
          await unlinkAsync(wallet.evmQrPath);
          logger.info(`Deleted old EVM QR code: ${wallet.evmQrPath}`);
        } catch (err) {
          logger.warn(`Failed to delete old EVM QR code ${wallet.evmQrPath} for user ${userId}: ${err.message}`);
        }
      }
      if (wallet.solanaQrPath && !newQrPaths.includes(wallet.solanaQrPath)) {
        try {
          await unlinkAsync(wallet.solanaQrPath);
          logger.info(`Deleted old Solana QR code: ${wallet.solanaQrPath}`);
        } catch (err) {
          logger.warn(`Failed to delete old Solana QR code ${wallet.solanaQrPath} for user ${userId}: ${err.message}`);
        }
      }
    }
  } catch (error) {
    logger.error(`Error cleaning up QR codes for user ${userId}: ${error.message}`);
  }
}

// Periodic QR Code Cleanup Job
async function cleanupOrphanedQrFiles() {
  try {
    const tempDir = __dirname;
    const files = await fs.promises.readdir(tempDir);
    const now = Date.now();
    const oneHour = 60 * 60 * 1000; // 1 hour in milliseconds

    for (const file of files) {
      if (file.startsWith('temp_evm_qr_') || file.startsWith('temp_solana_qr_')) {
        const filePath = path.join(tempDir, file);
        const stats = await fs.promises.stat(filePath);
        if (now - stats.mtimeMs > oneHour) {
          await unlinkAsync(filePath);
          logger.info(`Deleted orphaned QR file: ${filePath}`);
        }
      }
    }
  } catch (error) {
    logger.error(`Error in orphaned QR file cleanup: ${error.message}`);
  }
}
setInterval(cleanupOrphanedQrFiles, 6 * 60 * 60 * 1000); // Run every 6 hours

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
        matrix[j][i - 1] + 1, // deletion
        matrix[j - 1][i] + 1, // insertion
        matrix[j - 1][i - 1] + indicator // substitution
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

// Define Scenes
const bankLinkingScene = new Scenes.WizardScene(
  'bank_linking_scene',
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const walletIndex = ctx.session.bankLinking?.walletIndex;

    logger.info(`Entering bank_linking_scene step 1 for user ${userId}, walletIndex: ${walletIndex}`);

    if (walletIndex === undefined || walletIndex === null) {
      const userState = await getUserState(userId);
      const errorMsg = userState.usePidgin
        ? '⚠️ No wallet dey here. Click "💼 Generate Wallet" to start.'
        : '⚠️ No wallet selected for linking. Please generate a wallet first.';
      await ctx.replyWithMarkdown(errorMsg);
      return ctx.scene.leave();
    }

    ctx.session.bankLinking = ctx.session.bankLinking || {};
    ctx.session.bankLinking.bankData = { step: 1 };
    const userState = await getUserState(userId);
    const prompt = userState.usePidgin
      ? '🏦 Enter your bank name (e.g., GTBank, Access):'
      : '🏦 Please enter your bank name (e.g., GTBank, Access):';
    await ctx.replyWithMarkdown(prompt, Markup.inlineKeyboard([
      [Markup.button.callback('❌ Cancel', 'cancel_bank_linking')]
    ]));
    return ctx.wizard.next();
  },
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const input = ctx.message.text.trim();
    logger.info(`User ${userId} entered bank name: ${input} in bank_linking_scene step 2`);

    const userState = await getUserState(userId);
    const { bank, distance } = findClosestBank(input, bankList);

    if (!bank || distance > 3) {
      const errorMsg = userState.usePidgin
        ? `❌ Bank name no match o. Check your spelling or try:\n\n${bankList.map(b => `• ${b.name}`).join('\n')}\n\nTry again.`
        : `❌ No matching bank found. Check your spelling or try:\n\n${bankList.map(b => `• ${b.name}`).join('\n')}\n\nPlease try again.`;
      await ctx.replyWithMarkdown(errorMsg, Markup.inlineKeyboard([
        [Markup.button.callback('❌ Cancel', 'cancel_bank_linking')]
      ]));
      return;
    }

    if (distance > 0 && distance <= 3) {
      const confirmMsg = userState.usePidgin
        ? `You mean *${bank.name}*? You type "${input}".\n\nCorrect?`
        : `Did you mean *${bank.name}*? You entered "${input}".\n\nIs this correct?`;
      ctx.session.bankLinking.bankData.suggestedBank = bank;
      const sentMessage = await ctx.replyWithMarkdown(confirmMsg, Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes', 'confirm_suggested_bank')],
        [Markup.button.callback('❌ No', 'retry_bank_name')],
        [Markup.button.callback('❌ Cancel', 'cancel_bank_linking')]
      ]));
      ctx.session.bankLinking.suggestionMessageId = sentMessage.message_id;
      return;
    }

    ctx.session.bankLinking.bankData.bankName = bank.name;
    ctx.session.bankLinking.bankData.bankCode = bank.code;
    ctx.session.bankLinking.bankData.step = 2;

    const prompt = userState.usePidgin
      ? '🔢 Enter your 10-digit account number:'
      : '🔢 Please enter your 10-digit bank account number:';
    await ctx.replyWithMarkdown(prompt, Markup.inlineKeyboard([
      [Markup.button.callback('❌ Cancel', 'cancel_bank_linking')]
    ]));
    return ctx.wizard.next();
  },
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const input = ctx.message.text.trim();
    logger.info(`User ${userId} entered account number: ${input} in bank_linking_scene step 3`);

    const userState = await getUserState(userId);
    if (!/^\d{10}$/.test(input)) {
      const errorMsg = userState.usePidgin
        ? '❌ Account number no correct. Enter valid 10-digit number:'
        : '❌ Invalid account number. Please enter a valid 10-digit number:';
      await ctx.replyWithMarkdown(errorMsg, Markup.inlineKeyboard([
        [Markup.button.callback('❌ Cancel', 'cancel_bank_linking')]
      ]));
      return;
    }

    ctx.session.bankLinking.bankData.accountNumber = input;
    ctx.session.bankLinking.bankData.step = 3;

    const verifyingMsg = userState.usePidgin
      ? '🔄 Checking your bank details...'
      : '🔄 Verifying your bank details...';
    await ctx.replyWithMarkdown(verifyingMsg);

    try {
      const verificationResult = await verifyBankAccount(ctx.session.bankLinking.bankData.accountNumber, ctx.session.bankLinking.bankData.bankCode);

      if (!verificationResult || !verificationResult.data) {
        throw new Error('Invalid verification response.');
      }

      const accountName = verificationResult.data.account_name;
      if (!accountName) throw new Error('Unable to retrieve account name.');

      ctx.session.bankLinking.bankData.accountName = accountName;
      ctx.session.bankLinking.bankData.step = 4;

      const confirmMsg = userState.usePidgin
        ? `🏦 *Bank Account Check*\n\n` +
          `Confirm your details:\n` +
          `- *Bank Name:* ${ctx.session.bankLinking.bankData.bankName}\n` +
          `- *Account Number:* \`${ctx.session.bankLinking.bankData.accountNumber}\`\n` +
          `- *Account Holder:* ${accountName}\n\n` +
          `E correct?`
        : `🏦 *Bank Account Verification*\n\n` +
          `Please confirm your bank details:\n` +
          `- *Bank Name:* ${ctx.session.bankLinking.bankData.bankName}\n` +
          `- *Account Number:* \`${ctx.session.bankLinking.bankData.accountNumber}\`\n` +
          `- *Account Holder:* ${accountName}\n\n` +
          `Is this correct?`;
      await ctx.replyWithMarkdown(confirmMsg, Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes, Confirm', 'confirm_bank_yes')],
        [Markup.button.callback('❌ No, Edit Details', 'confirm_bank_no')],
        [Markup.button.callback('❌ Cancel', 'cancel_bank_linking')]
      ]));
      return ctx.wizard.next();
    } catch (error) {
      logger.error(`Error verifying bank account for user ${userId}: ${error.message}`);
      const errorMsg = userState.usePidgin
        ? '❌ E no work. Check your details or try again.'
        : '❌ Failed to verify your bank account. Check your details or try again.';
      await ctx.replyWithMarkdown(errorMsg, Markup.inlineKeyboard([
        [Markup.button.callback('❌ Cancel', 'cancel_bank_linking')]
      ]));
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
  const suggestedBank = ctx.session.bankLinking?.bankData?.suggestedBank;

  if (!suggestedBank) {
    const errorMsg = userState.usePidgin
      ? '❌ No bank selected. Start again.'
      : '❌ No bank selected. Please start over.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  ctx.session.bankLinking.bankData.bankName = suggestedBank.name;
  ctx.session.bankLinking.bankData.bankCode = suggestedBank.code;
  ctx.session.bankLinking.bankData.step = 2;

  const prompt = userState.usePidgin
    ? '🔢 Enter your 10-digit account number:'
    : '🔢 Please enter your 10-digit bank account number:';
  await ctx.replyWithMarkdown(prompt, Markup.inlineKeyboard([
    [Markup.button.callback('❌ Cancel', 'cancel_bank_linking')]
  ]));
  await ctx.answerCbQuery();
  ctx.wizard.selectStep(2);
});

bankLinkingScene.action('retry_bank_name', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  if (ctx.session.bankLinking?.suggestionMessageId) {
    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, ctx.session.bankLinking.suggestionMessageId);
      delete ctx.session.bankLinking.suggestionMessageId;
    } catch (error) {
      logger.error(`Failed to delete suggestion message for user ${userId}: ${error.message}`);
    }
  }

  const prompt = userState.usePidgin
    ? '🏦 Enter the correct bank name one more time (e.g., GTBank, Access):'
    : '🏦 Please enter the correct bank name one more time (e.g., GTBank, Access):';
  await ctx.replyWithMarkdown(prompt, Markup.inlineKeyboard([
    [Markup.button.callback('❌ Cancel', 'cancel_bank_linking')]
  ]));
  await ctx.answerCbQuery();
  ctx.wizard.selectStep(1);
});

bankLinkingScene.action('confirm_bank_yes', async (ctx) => {
  const userId = ctx.from.id.toString();
  const bankData = ctx.session.bankLinking?.bankData;
  const walletIndex = ctx.session.bankLinking?.walletIndex;
  const evmQrPath = path.join(__dirname, `temp_evm_qr_${userId}_${Date.now()}.png`);
  const solanaQrPath = path.join(__dirname, `temp_solana_qr_${userId}_${Date.now()}.png`);

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
    userState.wallets[walletIndex].evmQrPath = evmQrPath;
    userState.wallets[walletIndex].solanaQrPath = solanaQrPath;

    await generateQRCodeImage(userState.wallets[walletIndex].address, WALLET_GENERATED_IMAGE, evmQrPath);
    await generateQRCodeImage(userState.wallets[walletIndex].solanaAddress, WALLET_GENERATED_IMAGE, solanaQrPath);

    await updateUserState(userId, { wallets: userState.wallets });
    await cleanupOldQrCodes(userId, [evmQrPath, solanaQrPath]);

    const walletAddress = userState.wallets[walletIndex].address;
    const solanaAddress = userState.wallets[walletIndex].solanaAddress;

    const confirmationMessage = userState.usePidgin
      ? `✅ *Bank Account Linked*\n\n` +
        `*Bank Name:* ${bankData.bankName}\n` +
        `*Account Number:* \`${bankData.accountNumber}\`\n` +
        `*Account Holder:* ${bankData.accountName}\n\n` +
        `📂 *Wallet ${walletIndex + 1} Details (EVM):*\n` +
        `• *Chain:* Base\n` +
        `• *Address:* \`${walletAddress}\`\n` +
        `• *Supported Assets:* USDC, USDT\n\n` +
        `You fit start receive payouts now.\n\n*Refund Address:* Set one in "⚙️ Settings" if payout fail (default na this wallet).`
      : `✅ *Bank Account Linked*\n\n` +
        `*Bank Name:* ${bankData.bankName}\n` +
        `*Account Number:* \`${bankData.accountNumber}\`\n` +
        `*Account Holder:* ${bankData.accountName}\n\n` +
        `📂 *Wallet ${walletIndex + 1} Details (EVM):*\n` +
        `• *Chain:* Base\n` +
        `• *Address:* \`${walletAddress}\`\n` +
        `• *Supported Assets:* USDC, USDT\n\n` +
        `You can now receive payouts.\n\n*Refund Address:* Set one in "⚙️ Settings" for failed payouts (defaults to this wallet).`;

    const navigationButtons = [];
    navigationButtons.push([Markup.button.callback('🔄 Show Solana Wallet', `show_solana_wallet_${walletIndex}`)]);
    if (userState.wallets.length > 1) {
      if (walletIndex > 0) {
        navigationButtons.push([Markup.button.callback('⬅️ Previous Wallet', `prev_wallet_${walletIndex}`)]);
      }
      if (walletIndex < userState.wallets.length - 1) {
        navigationButtons.push([Markup.button.callback('➡️ Next Wallet', `next_wallet_${walletIndex}`)]);
      }
    }
    navigationButtons.push([Markup.button.callback('🏠 Main Menu', 'back_to_main')]);

    await ctx.replyWithPhoto({ source: createReadStream(evmQrPath) }, {
      caption: confirmationMessage,
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard(navigationButtons)
    });

    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🔗 User ${userId} linked a bank account:\n\n*Account Name:* ${bankData.accountName}\n*Bank Name:* ${bankData.bankName}\n*Account Number:* ****${bankData.accountNumber.slice(-4)}`, { parse_mode: 'Markdown' });
    logger.info(`User ${userId} linked a bank account: ${JSON.stringify(userState.wallets[walletIndex].bank)}`);

    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in confirm_bank_yes handler for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem linking bank. Try again later or contact [@maxcswap](https://t.me/maxcswap).'
      : '❌ Error confirming bank details. Try again later or contact [@maxcswap](https://t.me/maxcswap).';
    await ctx.replyWithMarkdown(errorMsg);

    if (fs.existsSync(evmQrPath)) {
      try {
        await unlinkAsync(evmQrPath);
      } catch (cleanupError) {
        logger.error(`Failed to clean up temp EVM QR file ${evmQrPath}: ${cleanupError.message}`);
      }
    }
    if (fs.existsSync(solanaQrPath)) {
      try {
        await unlinkAsync(solanaQrPath);
      } catch (cleanupError) {
        logger.error(`Failed to clean up temp Solana QR file ${solanaQrPath}: ${cleanupError.message}`);
      }
    }
    await ctx.answerCbQuery();
  } finally {
    delete ctx.session.bankLinking;
    ctx.scene.leave();
  }
});

bankLinkingScene.action('confirm_bank_no', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const retryMsg = userState.usePidgin
    ? '⚠️ Let’s start over. Enter your bank name again (e.g., GTBank, Access):'
    : '⚠️ Let\'s try again. Please enter your bank name again (e.g., GTBank, Access):';
  await ctx.replyWithMarkdown(retryMsg, Markup.inlineKeyboard([
    [Markup.button.callback('❌ Cancel', 'cancel_bank_linking')]
  ]));
  ctx.session.bankLinking.bankData = { step: 1 };
  await ctx.answerCbQuery();
  ctx.wizard.selectStep(1);
});

bankLinkingScene.action('cancel_bank_linking', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const walletIndex = ctx.session.bankLinking?.walletIndex;
  const wallet = userState.wallets[walletIndex];
  const errorMsg = userState.usePidgin
    ? `❌ You cancel bank linking. You must link bank to use wallet. Try again with "💼 Generate Wallet".`
    : `❌ Bank linking cancelled. You must link a bank to use your wallet. Try again with "💼 Generate Wallet".`;
  await ctx.replyWithMarkdown(errorMsg);
  if (wallet) {
    // Remove the unlinked wallet
    userState.wallets.splice(walletIndex, 1);
    userState.walletAddresses = userState.walletAddresses.filter(addr => addr !== wallet.address && addr !== wallet.solanaAddress);
    await updateUserState(userId, {
      wallets: userState.wallets,
      walletAddresses: userState.walletAddresses
    });
  }
  delete ctx.session.bankLinking;
  await ctx.answerCbQuery();
  ctx.scene.leave();
});

bankLinkingScene.action(/show_solana_wallet_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);
  const userState = await getUserState(userId);

  if (walletIndex >= userState.wallets.length) {
    const errorMsg = userState.usePidgin
      ? '❌ Wallet no dey. Start again.'
      : '❌ Invalid wallet. Please start over.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
    return;
  }

  const wallet = userState.wallets[walletIndex];
  let solanaQrPath = wallet.solanaQrPath;

  try {
    if (!solanaQrPath || !fs.existsSync(solanaQrPath)) {
      solanaQrPath = path.join(__dirname, `temp_solana_qr_${userId}_${Date.now()}.png`);
      await generateQRCodeImage(wallet.solanaAddress, WALLET_GENERATED_IMAGE, solanaQrPath);
      wallet.solanaQrPath = solanaQrPath;
      await updateUserState(userId, { wallets: userState.wallets });
      await cleanupOldQrCodes(userId, [wallet.evmQrPath, solanaQrPath]);
    }

    const message = userState.usePidgin
      ? `📂 *Wallet ${walletIndex + 1} Details (Solana):*\n\n` +
        `• *Chain:* Solana\n` +
        `• *Address:* \`${wallet.solanaAddress}\`\n` +
        `• *Supported Assets:* USDC, USDT\n` +
        `• *Bank Linked:* ${wallet.bank ? `${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)})` : 'None'}\n\n` +
        `You fit receive payouts now.\n\n*Refund Address:* Set one in "⚙️ Settings" if payout fail (default na this wallet).`
      : `📂 *Wallet ${walletIndex + 1} Details (Solana):*\n\n` +
        `• *Chain:* Solana\n` +
        `• *Address:* \`${wallet.solanaAddress}\`\n` +
        `• *Supported Assets:* USDC, USDT\n` +
        `• *Bank Linked:* ${wallet.bank ? `${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)})` : 'None'}\n\n` +
        `You can now receive payouts.\n\n*Refund Address:* Set one in "⚙️ Settings" for failed payouts (defaults to this wallet).`;

    const navigationButtons = [];
    navigationButtons.push([Markup.button.callback('🔄 Show EVM Wallet', `show_evm_wallet_${walletIndex}`)]);
    if (userState.wallets.length > 1) {
      if (walletIndex > 0) {
        navigationButtons.push([Markup.button.callback('⬅️ Previous Wallet', `prev_wallet_${walletIndex}`)]);
      }
      if (walletIndex < userState.wallets.length - 1) {
        navigationButtons.push([Markup.button.callback('➡️ Next Wallet', `next_wallet_${walletIndex}`)]);
      }
    }
    navigationButtons.push([Markup.button.callback('🏠 Main Menu', 'back_to_main')]);

    await ctx.editMessageMedia(
      { type: 'photo', media: { source: createReadStream(solanaQrPath) } },
      {
        caption: message,
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard(navigationButtons)
      }
    );

    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error showing Solana wallet for user ${userId}: ${error.message}`);
    const errorMsg = userState.usePidgin
      ? '❌ Problem showing Solana wallet. Try again later.'
      : '❌ Error showing Solana wallet. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
  }
});

bankLinkingScene.action(/show_evm_wallet_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);
  const userState = await getUserState(userId);

  if (walletIndex >= userState.wallets.length) {
    const errorMsg = userState.usePidgin
      ? '❌ Wallet no dey. Start again.'
      : '❌ Invalid wallet. Please start over.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
    return;
  }

  const wallet = userState.wallets[walletIndex];
  let evmQrPath = wallet.evmQrPath;

  try {
    if (!evmQrPath || !fs.existsSync(evmQrPath)) {
      evmQrPath = path.join(__dirname, `temp_evm_qr_${userId}_${Date.now()}.png`);
      await generateQRCodeImage(wallet.address, WALLET_GENERATED_IMAGE, evmQrPath);
      wallet.evmQrPath = evmQrPath;
      await updateUserState(userId, { wallets: userState.wallets });
      await cleanupOldQrCodes(userId, [evmQrPath, wallet.solanaQrPath]);
    }

    const message = userState.usePidgin
      ? `📂 *Wallet ${walletIndex + 1} Details (EVM):*\n\n` +
        `• *Chain:* Base\n` +
        `• *Address:* \`${wallet.address}\`\n` +
        `• *Supported Assets:* USDC, USDT\n` +
        `• *Bank Linked:* ${wallet.bank ? `${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)})` : 'None'}\n\n` +
        `You fit receive payouts now.\n\n*Refund Address:* Set one in "⚙️ Settings" if payout fail (default na this wallet).`
      : `📂 *Wallet ${walletIndex + 1} Details (EVM):*\n\n` +
        `• *Chain:* Base\n` +
        `• *Address:* \`${wallet.address}\`\n` +
        `• *Supported Assets:* USDC, USDT\n` +
        `• *Bank Linked:* ${wallet.bank ? `${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)})` : 'None'}\n\n` +
        `You can now receive payouts.\n\n*Refund Address:* Set one in "⚙️ Settings" for failed payouts (defaults to this wallet).`;

    const navigationButtons = [];
    navigationButtons.push([Markup.button.callback('🔄 Show Solana Wallet', `show_solana_wallet_${walletIndex}`)]);
    if (userState.wallets.length > 1) {
      if (walletIndex > 0) {
        navigationButtons.push([Markup.button.callback('⬅️ Previous Wallet', `prev_wallet_${walletIndex}`)]);
      }
      if (walletIndex < userState.wallets.length - 1) {
        navigationButtons.push([Markup.button.callback('➡️ Next Wallet', `next_wallet_${walletIndex}`)]);
      }
    }
    navigationButtons.push([Markup.button.callback('🏠 Main Menu', 'back_to_main')]);

    await ctx.editMessageMedia(
      { type: 'photo', media: { source: createReadStream(evmQrPath) } },
      {
        caption: message,
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard(navigationButtons)
      }
    );

    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error showing EVM wallet for user ${userId}: ${error.message}`);
    const errorMsg = userState.usePidgin
      ? '❌ Problem showing EVM wallet. Try again later.'
      : '❌ Error showing EVM wallet. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
  }
});

bankLinkingScene.action(/prev_wallet_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const currentIndex = parseInt(ctx.match[1], 10);
  const userState = await getUserState(userId);

  if (currentIndex <= 0) {
    await ctx.answerCbQuery('You are at the first wallet.');
    return;
  }

  const walletIndex = currentIndex - 1;
  const wallet = userState.wallets[walletIndex];
  let evmQrPath = wallet.evmQrPath;

  try {
    if (!evmQrPath || !fs.existsSync(evmQrPath)) {
      evmQrPath = path.join(__dirname, `temp_evm_qr_${userId}_${Date.now()}.png`);
      await generateQRCodeImage(wallet.address, WALLET_GENERATED_IMAGE, evmQrPath);
      wallet.evmQrPath = evmQrPath;
      await updateUserState(userId, { wallets: userState.wallets });
      await cleanupOldQrCodes(userId, [evmQrPath, wallet.solanaQrPath]);
    }

    const message = userState.usePidgin
      ? `📂 *Wallet ${walletIndex + 1} Details (EVM):*\n\n` +
        `• *Chain:* Base\n` +
        `• *Address:* \`${wallet.address}\`\n` +
        `• *Supported Assets:* USDC, USDT\n` +
        `• *Bank Linked:* ${wallet.bank ? `${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)})` : 'None'}\n\n` +
        `You fit receive payouts now.\n\n*Refund Address:* Set one in "⚙️ Settings" if payout fail (default na this wallet).`
      : `📂 *Wallet ${walletIndex + 1} Details (EVM):*\n\n` +
        `• *Chain:* Base\n` +
        `• *Address:* \`${wallet.address}\`\n` +
        `• *Supported Assets:* USDC, USDT\n` +
        `• *Bank Linked:* ${wallet.bank ? `${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)})` : 'None'}\n\n` +
        `You can now receive payouts.\n\n*Refund Address:* Set one in "⚙️ Settings" for failed payouts (defaults to this wallet).`;

    const navigationButtons = [];
    navigationButtons.push([Markup.button.callback('🔄 Show Solana Wallet', `show_solana_wallet_${walletIndex}`)]);
    if (userState.wallets.length > 1) {
      if (walletIndex > 0) {
        navigationButtons.push([Markup.button.callback('⬅️ Previous Wallet', `prev_wallet_${walletIndex}`)]);
      }
      if (walletIndex < userState.wallets.length - 1) {
        navigationButtons.push([Markup.button.callback('➡️ Next Wallet', `next_wallet_${walletIndex}`)]);
      }
    }
    navigationButtons.push([Markup.button.callback('🏠 Main Menu', 'back_to_main')]);

    await ctx.editMessageMedia(
      { type: 'photo', media: { source: createReadStream(evmQrPath) } },
      {
        caption: message,
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard(navigationButtons)
      }
    );

    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error showing previous wallet for user ${userId}: ${error.message}`);
    const errorMsg = userState.usePidgin
      ? '❌ Problem showing wallet. Try again later.'
      : '❌ Error showing wallet. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
  }
});

bankLinkingScene.action(/next_wallet_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const currentIndex = parseInt(ctx.match[1], 10);
  const userState = await getUserState(userId);

  if (currentIndex >= userState.wallets.length - 1) {
    await ctx.answerCbQuery('You are at the last wallet.');
    return;
  }

  const walletIndex = currentIndex + 1;
  const wallet = userState.wallets[walletIndex];
  let evmQrPath = wallet.evmQrPath;

  try {
    if (!evmQrPath || !fs.existsSync(evmQrPath)) {
      evmQrPath = path.join(__dirname, `temp_evm_qr_${userId}_${Date.now()}.png`);
      await generateQRCodeImage(wallet.address, WALLET_GENERATED_IMAGE, evmQrPath);
      wallet.evmQrPath = evmQrPath;
      await updateUserState(userId, { wallets: userState.wallets });
      await cleanupOldQrCodes(userId, [evmQrPath, wallet.solanaQrPath]);
    }

    const message = userState.usePidgin
      ? `📂 *Wallet ${walletIndex + 1} Details (EVM):*\n\n` +
        `• *Chain:* Base\n` +
        `• *Address:* \`${wallet.address}\`\n` +
        `• *Supported Assets:* USDC, USDT\n` +
        `• *Bank Linked:* ${wallet.bank ? `${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)})` : 'None'}\n\n` +
        `You fit receive payouts now.\n\n*Refund Address:* Set one in "⚙️ Settings" if payout fail (default na this wallet).`
      : `📂 *Wallet ${walletIndex + 1} Details (EVM):*\n\n` +
        `• *Chain:* Base\n` +
        `• *Address:* \`${wallet.address}\`\n` +
        `• *Supported Assets:* USDC, USDT\n` +
        `• *Bank Linked:* ${wallet.bank ? `${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)})` : 'None'}\n\n` +
        `You can now receive payouts.\n\n*Refund Address:* Set one in "⚙️ Settings" for failed payouts (defaults to this wallet).`;

    const navigationButtons = [];
    navigationButtons.push([Markup.button.callback('🔄 Show Solana Wallet', `show_solana_wallet_${walletIndex}`)]);
    if (userState.wallets.length > 1) {
      if (walletIndex > 0) {
        navigationButtons.push([Markup.button.callback('⬅️ Previous Wallet', `prev_wallet_${walletIndex}`)]);
      }
      if (walletIndex < userState.wallets.length - 1) {
        navigationButtons.push([Markup.button.callback('➡️ Next Wallet', `next_wallet_${walletIndex}`)]);
      }
    }
    navigationButtons.push([Markup.button.callback('🏠 Main Menu', 'back_to_main')]);

    await ctx.editMessageMedia(
      { type: 'photo', media: { source: createReadStream(evmQrPath) } },
      {
        caption: message,
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard(navigationButtons)
      }
    );

    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error showing next wallet for user ${userId}: ${error.message}`);
    const errorMsg = userState.usePidgin
      ? '❌ Problem showing wallet. Try again later.'
      : '❌ Error showing wallet. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
  }
});

const sendMessageScene = new Scenes.WizardScene(
  'send_message_scene',
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const userState = await getUserState(userId);
    await ctx.replyWithMarkdown(userState.usePidgin
      ? '📩 Enter User ID to message:'
      : '📩 Please enter the User ID you want to message:');
    ctx.session.sendMessage = ctx.session.sendMessage || {};
    return ctx.wizard.next();
  },
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const userIdToMessage = ctx.message.text.trim();
    const userState = await getUserState(userId);

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

    ctx.session.sendMessage.userIdToMessage = userIdToMessage;
    const prompt = userState.usePidgin
      ? '📝 Enter message for user or send receipt pic:'
      : '📝 Please enter the message or attach an image (receipt) for the user:';
    await ctx.replyWithMarkdown(prompt);
    return ctx.wizard.next();
  },
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const userIdToMessage = ctx.session.sendMessage?.userIdToMessage;
    const userState = await getUserState(userId);

    try {
      if (ctx.message.photo) {
        const photoArray = ctx.message.photo;
        const highestResolutionPhoto = photoArray[photoArray.length - 1];
        const fileId = highestResolutionPhoto.file_id;
        const caption = ctx.message.caption || '';

        await bot.telegram.sendPhoto(userIdToMessage, fileId, { caption: caption, parse_mode: 'Markdown' });
        const successMsg = userState.usePidgin
          ? '✅ Pic message don send.'
          : '✅ Photo message sent successfully.';
        await ctx.replyWithMarkdown(successMsg);
        logger.info(`Admin ${userId} sent photo message to user ${userIdToMessage}. Caption: ${caption}`);
      } else if (ctx.message.text) {
        const messageContent = ctx.message.text.trim();
        if (!messageContent) {
          const errorMsg = userState.usePidgin
            ? '❌ Message no fit empty. Enter something.'
            : '❌ Message content cannot be empty. Please enter a message:';
          await ctx.replyWithMarkdown(errorMsg);
          return;
        }

        await bot.telegram.sendMessage(userIdToMessage, `📩 *Message from Admin:*\n\n${messageContent}`, { parse_mode: 'Markdown' });
        const successMsg = userState.usePidgin
          ? '✅ Text message don send.'
          : '✅ Text message sent successfully.';
        await ctx.replyWithMarkdown(successMsg);
        logger.info(`Admin ${userId} sent text message to user ${userIdToMessage}: ${messageContent}`);
      } else {
        const errorMsg = userState.usePidgin
          ? '❌ Send text or pic abeg.'
          : '❌ Please send text or a photo.';
        await ctx.replyWithMarkdown(errorMsg);
        return;
      }
    } catch (error) {
      logger.error(`Error sending message to user ${userIdToMessage}: ${error.message}`);
      const errorMsg = userState.usePidgin
        ? '❌ Error sending message. Check User ID or try again.'
        : '❌ Error sending message. Ensure the User ID is correct.';
      await ctx.replyWithMarkdown(errorMsg);
    } finally {
      delete ctx.session.sendMessage;
      ctx.scene.leave();
    }
  }
);

// Receipt Generation Scene (Updated)
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

    ctx.session.receiptGeneration = ctx.session.receiptGeneration || {};

    if (userState.wallets.length === 1) {
      ctx.session.receiptGeneration.walletIndex = 0;
      return ctx.wizard.next();
    }

    const keyboard = userState.wallets.map((wallet, index) => [
      Markup.button.callback(`Wallet ${index + 1}${wallet.name ? ` (${wallet.name})` : ''} - ${wallet.chain}`, `select_receipt_wallet_${index}`)
    ]);
    keyboard.push([Markup.button.callback('🔙 Back to Main Menu', 'back_to_main')]);
    const prompt = userState.usePidgin
      ? '🧾 Select wallet to view transaction history:'
      : '🧾 Select a wallet to view its transaction history:';
    await ctx.replyWithMarkdown(prompt, Markup.inlineKeyboard(keyboard));
    return ctx.wizard.next();
  },
  async (ctx) => {
    const userId = ctx.from.id.toString();
    let walletIndex;

    if (ctx.session.receiptGeneration?.walletIndex === undefined || ctx.session.receiptGeneration?.walletIndex === null) {
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
      ctx.session.receiptGeneration.walletIndex = walletIndex;
    } else {
      walletIndex = ctx.session.receiptGeneration.walletIndex;
    }

    try {
      const userState = await getUserState(userId);
      const wallet = userState.wallets[walletIndex];

      if (!wallet) throw new Error('Wallet not found.');

      const transactionsSnapshot = await db.collection('transactions')
        .where('walletAddress', 'in', [wallet.address, wallet.solanaAddress])
        .orderBy('timestamp', 'desc')
        .limit(10)
        .get();

      let receiptMessage = userState.usePidgin
        ? `🧾 *Transaction History - Wallet ${walletIndex + 1}${wallet.name ? ` (${wallet.name})` : ''} (${wallet.chain})*\n\n`
        : `🧾 *Transaction History - Wallet ${walletIndex + 1}${wallet.name ? ` (${wallet.name})` : ''} (${wallet.chain})*\n\n`;

      if (transactionsSnapshot.empty) {
        receiptMessage += userState.usePidgin
          ? '📭 No transactions yet for this wallet.\n\nStart by sending USDC/USDT to your wallet address.'
          : '📭 No transactions found for this wallet yet.\n\nSend USDC/USDT to your wallet address to begin.';
      } else {
        receiptMessage += userState.usePidgin
          ? 'Here na your recent transactions:\n\n'
          : 'Here are your recent transactions:\n\n';
        transactionsSnapshot.forEach((doc, index) => {
          const tx = doc.data();
          receiptMessage += `📄 *Transaction ${index + 1}*\n` +
                           `- *Ref ID:* \`${tx.referenceId || 'N/A'}\`\n` +
                           `- *Amount:* ${tx.amount || 'N/A'} ${tx.asset || 'N/A'}\n` +
                           `- *Payout:* ₦${tx.payoutAmount || 'N/A'}\n` +
                           `- *Status:* ${tx.status || 'Pending'}\n` +
                           `- *Rate:* ₦${exchangeRates[tx.asset] || 'N/A'} per ${tx.asset || 'N/A'}\n` +
                           `- *Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n` +
                           `- *Chain:* ${tx.chain || 'N/A'}\n\n`;
        });
      }

      const exportMsg = userState.usePidgin
        ? '📥 Export this history as text file:'
        : '📥 Export this transaction history as a text file:';
      await ctx.replyWithMarkdown(receiptMessage + exportMsg, Markup.inlineKeyboard([
        transactionsSnapshot.empty ? [] : [Markup.button.callback('📤 Export', `export_receipt_${walletIndex}`)],
        [Markup.button.callback('🏠 Main Menu', 'back_to_main')]
      ].filter(row => row.length)));
    } catch (error) {
      logger.error(`Error generating receipt for user ${userId}: ${error.message}`);
      const userState = await getUserState(userId);
      const errorMsg = userState.usePidgin
        ? '❌ Error fetching transaction history. Try again later.'
        : '❌ An error occurred while fetching transaction history. Try again later.';
      await ctx.replyWithMarkdown(errorMsg);
    } finally {
      delete ctx.session.receiptGeneration;
      ctx.scene.leave();
    }
  }
);

// Register Scenes with Stage
const stage = new Scenes.Stage();
stage.register(bankLinkingScene, sendMessageScene, receiptGenerationScene);
bot.use(session());
bot.use(stage.middleware());

// Apply Telegraf Webhook Middleware
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

// Apply Other Middlewares
app.use(requestIp.mw());
app.post(WEBHOOK_PAYCREST_PATH, bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  await handlePaycrestWebhook(req, res);
});
app.use(bodyParser.json());
app.get('/cron/fetch-rates', async (req, res) => {
  try {
    await fetchExchangeRates();
    logger.info('Cron job: Exchange rates fetched successfully');
    res.status(200).json({ status: 'success', message: 'Exchange rates updated' });
  } catch (error) {
    logger.error(`Cron job error: ${error.message}`);
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🚨 Cron job failed: ${error.message}`, { parse_mode: 'Markdown' });
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Main Menu
const getMainMenu = (walletExists, hasBankLinked) =>
  Markup.keyboard([
    [walletExists ? "💼 View Wallet" : "💼 Generate Wallet", "⚙️ Settings"],
    ["💰 Transactions", "ℹ️ Support"],
    ["📈 View Current Rates"],
  ]).resize();

const getSettingsMenu = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Generate New Wallet', 'settings_generate_wallet')],
    [Markup.button.callback('✏️ Edit Bank Details', 'settings_edit_bank')],
    [Markup.button.callback('📝 Rename Wallet', 'settingsrename_wallet')],
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

// Check if User is Admin
const isAdmin = (userId) => ADMIN_IDS.split(',').map(id => id.trim()).includes(userId.toString());

// Fetch Exchange Rates
async function fetchExchangeRate(asset) {
  try {
    const response = await axios.get(`${PAYCREST_RATE_API_URL}?asset=${asset}`, {
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
setInterval(fetchExchangeRates, 300000); // 5 minutes

// Paycrest Webhook Handler
async function handlePaycrestWebhook(req, res) {
  const userId = req.body.userId || 'unknown';
  const rawBody = req.body;
  const signature = req.headers['x-paycrest-signature'];

  try {
    const isValidSignature = verifyPaycrestSignature(JSON.stringify(rawBody), signature, PAYCREST_CLIENT_SECRET);
    if (!isValidSignature) {
      logger.error(`Invalid Paycrest webhook signature for user ${userId}`);
      return res.status(401).json({ status: 'error', message: 'Invalid signature' });
    }

    const event = rawBody.event;
    const data = rawBody.data;

    if (event === 'order.completed') {
      const transactionRef = data.referenceId;
      const transactionDoc = await db.collection('transactions').where('referenceId', '==', transactionRef).get();

      if (transactionDoc.empty) {
        logger.error(`No transaction found for reference ${transactionRef}`);
        return res.status(404).json({ status: 'error', message: 'Transaction not found' });
      }

      const transaction = transactionDoc.docs[0].data();
      const userId = transaction.userId;

      await db.collection('transactions').doc(transactionDoc.docs[0].id).update({
        status: 'Completed',
        payoutCompletionTime: new Date().toISOString()
      });

      const userState = await getUserState(userId);
      const walletIndex = userState.wallets.findIndex(w => w.address === transaction.walletAddress || w.solanaAddress === transaction.walletAddress);
      if (walletIndex !== -1) {
        userState.wallets[walletIndex].totalPayouts = (userState.wallets[walletIndex].totalPayouts || 0) + transaction.payoutAmount;
        await updateUserState(userId, { wallets: userState.wallets });
      }

      const completionMessage = userState.usePidgin
        ? `✅ *Payout Done!*\n\n` +
          `You don get your money for bank!\n\n` +
          `📋 *Details:*\n` +
          `- *Ref ID:* \`${transaction.referenceId}\`\n` +
          `- *Amount:* ${transaction.amount} ${transaction.asset}\n` +
          `- *Payout:* ₦${transaction.payoutAmount}\n` +
          `- *Bank:* ${transaction.bankName} (****${transaction.accountNumber.slice(-4)})\n` +
          `- *Date:* ${new Date().toLocaleString()}\n\n` +
          `Check your account!`
        : `✅ *Payout Completed!*\n\n` +
          `Your payout has been successfully processed.\n\n` +
          `📋 *Details:*\n\n` +
          `- *Reference ID:* \`${transaction.referenceId}\`\n` +
          `- *Amount:* ${transaction.amount} ${transaction.asset}\n` +
          `- *Payout Amount:* ₦${transaction.payoutAmount}\n` +
          `- *Bank:* ${transaction.bankName} (****${transaction.accountNumber.slice(-4)})\n` +
          `- *Date:* ${new Date().toLocaleString()}\n\n` +
          `Please verify the funds in your bank account.`;

      await bot.telegram.sendPhoto(userId, { source: PAYOUT_SUCCESS_IMAGE }, {
        caption: completionMessage,
        parse_mode: 'Markdown'
      });

      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `✅ Payout completed for user ${userId}:\n\n` +
        `*Ref ID:* ${transaction.referenceId}\n` +
        `*Amount:* ${transaction.amount} ${transaction.asset}\n` +
        `*Payout:* ₦${transaction.payoutAmount}\n` +
        `*Bank:* ${transaction.bankName} (****${transaction.accountNumber.slice(-4)})`, { parse_mode: 'Markdown' });

      logger.info(`Payout completed for user ${userId}: ${transaction.referenceId}`);
      res.status(200).json({ status: 'success' });
    } else if (event === 'order.failed') {
      const transactionRef = data.referenceId;
      const transactionDoc = await db.collection('transactions').where('referenceId', '==', transactionRef).get();

      if (transactionDoc.empty) {
        logger.error(`No transaction found for failed order reference ${transactionRef}`);
        return res.status(404).json({ status: 'error', message: 'Transaction not found' });
      }

      const transaction = transactionDoc.docs[0].data();
      const userId = transaction.userId;
      const userState = await getUserState(userId);

      await db.collection('transactions').doc(transactionDoc.docs[0].id).update({
        status: 'Failed',
        failureReason: data.reason || 'Unknown error',
        updatedAt: new Date().toISOString()
      });

      let refundAddress = userState.refundAddress || transaction.walletAddress;
      if (!refundAddress) {
        logger.warn(`No refund address set for user ${userId}. Using default Paycrest return address.`);
        refundAddress = PAYCREST_RETURN_ADDRESS;
      }

      try {
        const chainData = chains[transaction.chain];
        const assetId = chainData.assets[transaction.asset];
        const reference = `REFUND_${transaction.referenceId}`;
        const metadata = { userId, originalTx: transaction.referenceId };

        await withdrawFromBlockradar(
          transaction.chain,
          assetId,
          refundAddress,
          transaction.amount,
          reference,
          metadata
        );

        const failureMessage = userState.usePidgin
          ? `❌ *Payout No Work!*\n\n` +
            `Your payout no go through because: *${data.reason || 'Unknown error'}*.\n\n` +
            `📋 *Details:*\n` +
            `- *Ref ID:* \`${transaction.referenceId}\`\n` +
            `- *Amount:* ${transaction.amount} ${transaction.asset}\n` +
            `- *Bank:* ${transaction.bankName} (****${transaction.accountNumber.slice(-4)})\n` +
            `- *Refund To:* \`${refundAddress}\`\n\n` +
            `Your ${transaction.amount} ${transaction.asset} don go back to your wallet. Try again or contact [@maxcswap](https://t.me/maxcswap).`
          : `❌ *Payout Failed!*\n\n` +
            `Your payout could not be processed due to: *${data.reason || 'Unknown error'}*.\n\n` +
            `📋 *Details:*\n\n` +
            `- *Reference ID:* \`${transaction.referenceId}\`\n` +
            `- *Amount:* ${transaction.amount} ${transaction.asset}\n` +
            `- *Bank:* ${transaction.bankName} (****${transaction.accountNumber.slice(-4)})\n` +
            `- *Refund Address:* \`${refundAddress}\`\n\n` +
            `Your ${transaction.amount} ${transaction.asset} has been refunded to your wallet. Please try again or contact [@maxcswap](https://t.me/maxcswap).`;

        await bot.telegram.sendPhoto(userId, { source: ERROR_IMAGE }, {
          caption: failureMessage,
          parse_mode: 'Markdown'
        });

        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🚨 Payout failed for user ${userId}:\n\n` +
          `*Ref ID:* ${transaction.referenceId}\n` +
          `*Amount:* ${transaction.amount} ${transaction.asset}\n` +
          `*Reason:* ${data.reason || 'Unknown error'}\n` +
          `*Refunded To:* ${refundAddress}`, { parse_mode: 'Markdown' });

        logger.info(`Payout failed for user ${userId}: ${transaction.referenceId}. Refunded ${transaction.amount} ${transaction.asset} to ${refundAddress}`);
      } catch (refundError) {
        logger.error(`Failed to process refund for user ${userId}, tx ${transaction.referenceId}: ${refundError.message}`);
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🚨 Refund failed for user ${userId}:\n\n` +
          `*Ref ID:* ${transaction.referenceId}\n` +
          `*Amount:* ${transaction.amount} ${transaction.asset}\n` +
          `*Error:* ${refundError.message}\n` +
          `Manual action required!`, { parse_mode: 'Markdown' });
      }

      res.status(200).json({ status: 'success' });
    } else {
      logger.warn(`Unhandled Paycrest webhook event: ${event}`);
      res.status(400).json({ status: 'error', message: 'Unhandled event' });
    }
  } catch (error) {
    logger.error(`Error processing Paycrest webhook for user ${userId}: ${error.message}`);
    res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
}

// Blockradar Webhook Handler
app.post(WEBHOOK_BLOCKRADAR_PATH, bodyParser.json(), async (req, res) => {
  const userId = req.body.metadata?.userId || 'unknown';
  try {
    const event = req.body.event;
    const data = req.body.data;

    if (event === 'deposit.confirmed') {
      const { walletAddress, amount, assetId, transactionHash, chain } = data;
      const chainKey = chainMapping[chain.toLowerCase()];
      if (!chainKey) {
        logger.error(`Unknown chain received in Blockradar webhook: ${chain}`);
        return res.status(400).json({ status: 'error', message: 'Unknown chain' });
      }

      const chainData = chains[chainKey];
      const asset = Object.keys(chainData.assets).find(key => chainData.assets[key] === assetId);
      if (!asset) {
        logger.error(`Unknown assetId ${assetId} for chain ${chainKey}`);
        return res.status(400).json({ status: 'error', message: 'Unknown asset' });
      }

      const userDoc = await db.collection('users')
        .where('walletAddresses', 'array-contains', walletAddress)
        .limit(1)
        .get();

      if (userDoc.empty) {
        logger.error(`No user found for wallet address ${walletAddress}`);
        return res.status(404).json({ status: 'error', message: 'User not found' });
      }

      const userId = userDoc.docs[0].id;
      const userState = await getUserState(userId);
      const walletIndex = userState.wallets.findIndex(w => w.address === walletAddress || w.solanaAddress === walletAddress);
      if (walletIndex === -1 || !userState.wallets[walletIndex].bank) {
        logger.error(`No linked bank account for wallet ${walletAddress} (user ${userId})`);
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🚨 Deposit received for user ${userId} but no linked bank account:\n\n` +
          `*Address:* ${walletAddress}\n` +
          `*Amount:* ${amount} ${asset}\n` +
          `*Chain:* ${chainKey}\n` +
          `*Tx Hash:* [${transactionHash}](${chainData.explorer}${transactionHash})`, { parse_mode: 'Markdown' });
        return res.status(400).json({ status: 'error', message: 'No linked bank account' });
      }

      const bankDetails = userState.wallets[walletIndex].bank;
      const referenceId = generateReferenceId();
      const payoutAmount = calculatePayout(asset, amount);

      const transactionData = {
        userId,
        walletAddress,
        amount: parseFloat(amount),
        asset,
        chain: chainKey,
        transactionHash,
        referenceId,
        status: 'Pending',
        payoutAmount,
        bankName: bankDetails.bankName,
        accountNumber: bankDetails.accountNumber,
        accountName: bankDetails.accountName,
        timestamp: new Date().toISOString()
      };

      await db.collection('transactions').add(transactionData);

      try {
        const order = await createPaycrestOrder(
          userId,
          amount,
          asset,
          chainKey,
          bankDetails,
          userState.wallets[walletIndex].address
        );

        await db.collection('transactions').where('referenceId', '==', referenceId).limit(1).get()
          .then(async (snapshot) => {
            if (!snapshot.empty) {
              await snapshot.docs[0].ref.update({
                paycrestOrderId: order.orderId,
                paycrestStatus: 'Initiated'
              });
            }
          });

        const depositMessage = userState.usePidgin
          ? `💰 *Deposit Don Land!*\n\n` +
            `We don see your deposit:\n\n` +
            `- *Amount:* ${amount} ${asset}\n` +
            `- *Payout:* ₦${payoutAmount}\n` +
            `- *Ref ID:* \`${referenceId}\`\n` +
            `- *Chain:* ${chainKey}\n` +
            `- *Bank:* ${bankDetails.bankName} (****${bankDetails.accountNumber.slice(-4)})\n` +
            `- *Tx Hash:* [${transactionHash.substring(0, 10)}...](${chainData.explorer}${transactionHash})\n\n` +
            `We dey process your payout. You go get alert soon!`
          : `💰 *Deposit Received!*\n\n` +
            `We have received your deposit:\n\n` +
            `- *Amount:* ${amount} ${asset}\n` +
            `- *Payout Amount:* ₦${payoutAmount}\n` +
            `- *Reference ID:* \`${referenceId}\`\n` +
            `- *Chain:* ${chainKey}\n` +
            `- *Bank:* ${bankDetails.bankName} (****${bankDetails.accountNumber.slice(-4)})\n` +
            `- *Tx Hash:* [${transactionHash.substring(0, 10)}...](${chainData.explorer}${transactionHash})\n\n` +
            `Your payout is being processed. You'll receive a confirmation soon!`;

        await bot.telegram.sendPhoto(userId, { source: DEPOSIT_SUCCESS_IMAGE }, {
          caption: depositMessage,
          parse_mode: 'Markdown'
        });

        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `💰 New deposit for user ${userId}:\n\n` +
          `*Amount:* ${amount} ${asset}\n` +
          `*Payout:* ₦${payoutAmount}\n` +
          `*Ref ID:* ${referenceId}\n` +
          `*Chain:* ${chainKey}\n` +
          `*Bank:* ${bankDetails.bankName} (****${bankDetails.accountNumber.slice(-4)})\n` +
          `*Tx Hash:* [${transactionHash}](${chainData.explorer}${transactionHash})`, { parse_mode: 'Markdown' });

        if (!userState.hasReceivedDeposit) {
          await updateUserState(userId, { hasReceivedDeposit: true });
        }

        logger.info(`Deposit processed for user ${userId}: ${amount} ${asset}, Ref: ${referenceId}`);
      } catch (orderError) {
        logger.error(`Failed to create Paycrest order for user ${userId}, Ref: ${referenceId}: ${orderError.message}`);
        await db.collection('transactions').where('referenceId', '==', referenceId).limit(1).get()
          .then(async (snapshot) => {
            if (!snapshot.empty) {
              await snapshot.docs[0].ref.update({
                status: 'Failed',
                failureReason: `Paycrest order creation failed: ${orderError.message}`
              });
            }
          });

        const errorMessage = userState.usePidgin
          ? `❌ *Deposit No Go Through!*\n\n` +
            `We see your deposit but e no work for payout:\n\n` +
            `- *Amount:* ${amount} ${asset}\n` +
            `- *Ref ID:* \`${referenceId}\`\n` +
            `- *Chain:* ${chainKey}\n` +
            `- *Error:* ${orderError.message}\n\n` +
            `Your funds dey safe. Contact [@maxcswap](https://t.me/maxcswap) for help.`
          : `❌ *Deposit Processing Failed!*\n\n` +
            `We received your deposit, but there was an issue processing the payout:\n\n` +
            `- *Amount:* ${amount} ${asset}\n` +
            `- *Reference ID:* \`${referenceId}\`\n` +
            `- *Chain:* ${chainKey}\n` +
            `- *Error:* ${orderError.message}\n\n` +
            `Your funds are safe. Please contact [@maxcswap](https://t.me/maxcswap) for assistance.`;

        await bot.telegram.sendPhoto(userId, { source: ERROR_IMAGE }, {
          caption: errorMessage,
          parse_mode: 'Markdown'
        });

        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🚨 Deposit processing failed for user ${userId}:\n\n` +
          `*Amount:* ${amount} ${asset}\n` +
          `*Ref ID:* ${referenceId}\n` +
          `*Chain:* ${chainKey}\n` +
          `*Error:* ${orderError.message}\n` +
          `*Tx Hash:* [${transactionHash}](${chainData.explorer}${transactionHash})`, { parse_mode: 'Markdown' });
      }

      res.status(200).json({ status: 'success' });
    } else {
      logger.warn(`Unhandled Blockradar webhook event: ${event}`);
      res.status(400).json({ status: 'error', message: 'Unhandled event' });
    }
  } catch (error) {
    logger.error(`Error processing Blockradar webhook for user ${userId}: ${error.message}`);
    res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
});

// Bot Commands and Actions
bot.command('start', async (ctx) => {
  const userId = ctx.from.id.toString();
  const firstName = ctx.from.first_name || 'User';
  const userState = await getUserState(userId);

  await updateUserState(userId, { firstName });

  const walletExists = userState.wallets.length > 0;
  const hasBankLinked = userState.wallets.some(w => w.bank);

 const welcomeMessage = userState.usePidgin
    ? `👋 Welcome, *${firstName}*! You don land for *DirectPay*!\n\n` +
      `This bot dey help you swap USDC/USDT to Naira straight to your bank account. Fast and easy!\n\n` +
      `${walletExists ? `You don get ${userState.wallets.length} wallet${userState.wallets.length > 1 ? 's' : ''}. Check am with "💼 View Wallet".` : 'No wallet yet. Click *💼 Generate Wallet* to start.'}` +
      `${hasBankLinked ? '' : '\n\nYou go need link bank account to receive Naira.'}\n\n` +
      `Pick option to continue:`
    : `👋 Welcome, *${firstName}*! This is *DirectPay*!\n\n` +
      `This bot allows you to convert USDC/USDT to Naira directly to your bank account. Fast and secure!\n\n` +
      `${walletExists ? `You already have ${userState.wallets.length} wallet${userState.wallets.length > 1 ? 's' : ''}. View them with "💼 View Wallet".` : 'You don\'t have a wallet yet. Click *💼 Generate Wallet* to get started.'}` +
      `${hasBankLinked ? '' : '\n\nYou\'ll need to link a bank account to receive Naira payouts.'}\n\n` +
      `Choose an option to proceed:`;

  await ctx.replyWithMarkdown(welcomeMessage, getMainMenu(walletExists, hasBankLinked));
  logger.info(`User ${userId} started the bot.`);
});

bot.hears('💼 Generate Wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  if (userState.wallets.length >= parseInt(MAX_WALLETS, 10)) {
    const errorMsg = userState.usePidgin
      ? `❌ You don reach max wallet limit (${MAX_WALLETS}). Manage your current wallets for "⚙️ Settings".`
      : `❌ You have reached the maximum wallet limit (${MAX_WALLETS}). Manage your existing wallets in "⚙️ Settings".`;
    await ctx.replyWithMarkdown(errorMsg);
    return;
  }

  try {
    const evmAddress = await generateWallet('Base');
    const solanaAddress = await generateWallet('Solana');
    const evmQrPath = path.join(__dirname, `temp_evm_qr_${userId}_${Date.now()}.png`);
    const solanaQrPath = path.join(__dirname, `temp_solana_qr_${userId}_${Date.now()}.png`);

    await generateQRCodeImage(evmAddress, WALLET_GENERATED_IMAGE, evmQrPath);
    await generateQRCodeImage(solanaAddress, WALLET_GENERATED_IMAGE, solanaQrPath);

    const newWallet = {
      chain: 'Base',
      address: evmAddress,
      solanaAddress,
      evmQrPath,
      solanaQrPath,
      bank: null,
      totalPayouts: 0
    };

    userState.wallets.push(newWallet);
    userState.walletAddresses.push(evmAddress, solanaAddress);
    await updateUserState(userId, {
      wallets: userState.wallets,
      walletAddresses: userState.walletAddresses
    });
    await cleanupOldQrCodes(userId, [evmQrPath, solanaQrPath]);

    ctx.session.bankLinking = { walletIndex: userState.wallets.length - 1 };
    await ctx.replyWithMarkdown(userState.usePidgin
      ? `✅ *Wallet Don Ready!*\n\n` +
        `You must link bank account to use this wallet.\n\n` +
        `🏦 Start linking your bank now:`
      : `✅ *Wallet Generated!*\n\n` +
        `You need to link a bank account to use this wallet.\n\n` +
        `🏦 Begin linking your bank account now:`);
    await ctx.scene.enter('bank_linking_scene');

    logger.info(`User ${userId} generated new wallet: ${evmAddress} (Base), ${solanaAddress} (Solana)`);
  } catch (error) {
    logger.error(`Error generating wallet for user ${userId}: ${error.message}`);
    const errorMsg = userState.usePidgin
      ? '❌ Problem creating wallet. Try again or contact [@maxcswap](https://t.me/maxcswap).'
      : '❌ Failed to generate wallet. Please try again or contact [@maxcswap](https://t.me/maxcswap).';
    await ctx.replyWithMarkdown(errorMsg);
  }
});

bot.hears('💼 View Wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  if (userState.wallets.length === 0) {
    const errorMsg = userState.usePidgin
      ? '❌ No wallet dey. Click "💼 Generate Wallet" to start.'
      : '❌ You have no wallets. Generate one with "💼 Generate Wallet".';
    await ctx.replyWithMarkdown(errorMsg);
    return;
  }

  const walletIndex = 0;
  const wallet = userState.wallets[walletIndex];
  let evmQrPath = wallet.evmQrPath;

  try {
    if (!evmQrPath || !fs.existsSync(evmQrPath)) {
      evmQrPath = path.join(__dirname, `temp_evm_qr_${userId}_${Date.now()}.png`);
      await generateQRCodeImage(wallet.address, WALLET_GENERATED_IMAGE, evmQrPath);
      wallet.evmQrPath = evmQrPath;
      await updateUserState(userId, { wallets: userState.wallets });
      await cleanupOldQrCodes(userId, [evmQrPath, wallet.solanaQrPath]);
    }

    const message = userState.usePidgin
      ? `📂 *Wallet ${walletIndex + 1} Details (EVM):*\n\n` +
        `• *Chain:* Base\n` +
        `• *Address:* \`${wallet.address}\`\n` +
        `• *Supported Assets:* USDC, USDT\n` +
        `• *Bank Linked:* ${wallet.bank ? `${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)})` : 'None'}\n\n` +
        `You fit receive payouts now.\n\n*Refund Address:* Set one in "⚙️ Settings" if payout fail (default na this wallet).`
      : `📂 *Wallet ${walletIndex + 1} Details (EVM):*\n\n` +
        `• *Chain:* Base\n` +
        `• *Address:* \`${wallet.address}\`\n` +
        `• *Supported Assets:* USDC, USDT\n` +
        `• *Bank Linked:* ${wallet.bank ? `${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)})` : 'None'}\n\n` +
        `You can now receive payouts.\n\n*Refund Address:* Set one in "⚙️ Settings" for failed payouts (defaults to this wallet).`;

    const navigationButtons = [];
    navigationButtons.push([Markup.button.callback('🔄 Show Solana Wallet', `show_solana_wallet_${walletIndex}`)]);
    if (userState.wallets.length > 1) {
      if (walletIndex < userState.wallets.length - 1) {
        navigationButtons.push([Markup.button.callback('➡️ Next Wallet', `next_wallet_${walletIndex}`)]);
      }
    }
    navigationButtons.push([Markup.button.callback('🏠 Main Menu', 'back_to_main')]);

    await ctx.replyWithPhoto({ source: createReadStream(evmQrPath) }, {
      caption: message,
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard(navigationButtons)
    });

    logger.info(`User ${userId} viewed wallet ${walletIndex + 1}`);
  } catch (error) {
    logger.error(`Error viewing wallet for user ${userId}: ${error.message}`);
    const errorMsg = userState.usePidgin
      ? '❌ Problem showing wallet. Try again later.'
      : '❌ Error displaying wallet. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
  }
});

bot.hears('⚙️ Settings', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  const settingsMessage = userState.usePidgin
    ? `⚙️ *Settings*\n\nPick option to manage your account:`
    : `⚙️ *Settings*\n\nChoose an option to manage your account:`;

  await ctx.replyWithMarkdown(settingsMessage, getSettingsMenu());
  if (isAdmin(userId)) {
    await ctx.replyWithMarkdown(userState.usePidgin
      ? `👨‍💼 *Admin Options*\n\nYou fit manage bot here:`
      : `👨‍💼 *Admin Options*\n\nManage bot operations below:`, getAdminMenu());
  }
  logger.info(`User ${userId} accessed settings menu.`);
});

bot.hears('💰 Transactions', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  await ctx.replyWithMarkdown(userState.usePidgin
    ? `🧾 *Your Transactions*\n\nYou wan check your transaction history?`
    : `🧾 *Your Transactions*\n\nView your transaction history below:`);
  await ctx.scene.enter('receipt_generation_scene');
});

bot.hears('ℹ️ Support', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  const supportMessage = userState.usePidgin
    ? `ℹ️ *Support*\n\nYou get any issue or question? Contact our team:\n\n` +
      `👉 *Telegram:* [@maxcswap](https://t.me/maxcswap)\n` +
      `📩 *Your User ID:* \`${userId}\` (share this if you dey report issue)\n\n` +
      `We dey here to help you!`
    : `ℹ️ *Support*\n\nHave an issue or question? Reach out to our support team:\n\n` +
      `👉 *Telegram:* [@maxcswap](https://t.me/maxcswap)\n` +
      `📩 *Your User ID:* \`${userId}\` (please provide this when reporting issues)\n\n` +
      `We're here to assist you!`;

  await ctx.replyWithMarkdown(supportMessage);
  logger.info(`User ${userId} accessed support information.`);
});

bot.hears('📈 View Current Rates', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  try {
    await fetchExchangeRates();
    const ratesMessage = userState.usePidgin
      ? `📈 *Current Rates*\n\n` +
        `Check how much Naira you go get for your crypto:\n\n` +
        `${SUPPORTED_ASSETS.map(asset => `- *${asset}:* ₦${exchangeRates[asset].toLocaleString()} per ${asset}`).join('\n')}\n\n` +
        `Rates fit change anytime. Send crypto to your wallet to swap!`
      : `📈 *Current Exchange Rates*\n\n` +
        `See how much Naira you'll receive for your crypto:\n\n` +
        `${SUPPORTED_ASSETS.map(asset => `- *${asset}:* ₦${exchangeRates[asset].toLocaleString()} per ${asset}`).join('\n')}\n\n` +
        `Rates are subject to change. Send crypto to your wallet to convert!`;

    await ctx.replyWithMarkdown(ratesMessage);
    logger.info(`User ${userId} viewed current exchange rates.`);
  } catch (error) {
    logger.error(`Error fetching rates for user ${userId}: ${error.message}`);
    const errorMsg = userState.usePidgin
      ? '❌ Problem getting rates. Try again later.'
      : '❌ Unable to fetch rates. Please try again later.';
    await ctx.replyWithMarkdown(errorMsg);
  }
});

bot.action('back_to_main', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  const walletExists = userState.wallets.length > 0;
  const hasBankLinked = userState.wallets.some(w => w.bank);

  const mainMenuMessage = userState.usePidgin
    ? `🏠 *Back to Main Menu*\n\nPick option to continue:`
    : `🏠 *Main Menu*\n\nChoose an option to proceed:`;

  await ctx.editMessageText(mainMenuMessage, {
    parse_mode: 'Markdown',
    reply_markup: getMainMenu(walletExists, hasBankLinked).reply_markup
  });
  await ctx.answerCbQuery();
  logger.info(`User ${userId} returned to main menu.`);
});

bot.action('settings_generate_wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  if (userState.wallets.length >= parseInt(MAX_WALLETS, 10)) {
    const errorMsg = userState.usePidgin
      ? `❌ You don reach max wallet limit (${MAX_WALLETS}). Manage your current wallets.`
      : `❌ You have reached the maximum wallet limit (${MAX_WALLETS}). Please manage your existing wallets.`;
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
    return;
  }

  try {
    const evmAddress = await generateWallet('Base');
    const solanaAddress = await generateWallet('Solana');
    const evmQrPath = path.join(__dirname, `temp_evm_qr_${userId}_${Date.now()}.png`);
    const solanaQrPath = path.join(__dirname, `temp_solana_qr_${userId}_${Date.now()}.png`);

    await generateQRCodeImage(evmAddress, WALLET_GENERATED_IMAGE, evmQrPath);
    await generateQRCodeImage(solanaAddress, WALLET_GENERATED_IMAGE, solanaQrPath);

    const newWallet = {
      chain: 'Base',
      address: evmAddress,
      solanaAddress,
      evmQrPath,
      solanaQrPath,
      bank: null,
      totalPayouts: 0
    };

    userState.wallets.push(newWallet);
    userState.walletAddresses.push(evmAddress, solanaAddress);
    await updateUserState(userId, {
      wallets: userState.wallets,
      walletAddresses: userState.walletAddresses
    });
    await cleanupOldQrCodes(userId, [evmQrPath, solanaQrPath]);

    ctx.session.bankLinking = { walletIndex: userState.wallets.length - 1 };
    await ctx.replyWithMarkdown(userState.usePidgin
      ? `✅ *Wallet Don Ready!*\n\n` +
        `You must link bank account to use this wallet.\n\n` +
        `🏦 Start linking your bank now:`
      : `✅ *Wallet Generated!*\n\n` +
        `You need to link a bank account to use this wallet.\n\n` +
        `🏦 Begin linking your bank account now:`);
    await ctx.scene.enter('bank_linking_scene');

    logger.info(`User ${userId} generated new wallet from settings: ${evmAddress} (Base), ${solanaAddress} (Solana)`);
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error generating wallet from settings for user ${userId}: ${error.message}`);
    const errorMsg = userState.usePidgin
      ? '❌ Problem creating wallet. Try again or contact [@maxcswap](https://t.me/maxcswap).'
      : '❌ Failed to generate wallet. Please try again or contact [@maxcswap](https://t.me/maxcswap).';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
  }
});

bot.action('settings_edit_bank', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  if (userState.wallets.length === 0) {
    const errorMsg = userState.usePidgin
      ? '❌ No wallet dey. Generate one first.'
      : '❌ You have no wallets. Generate one first.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
    return;
  }

  if (userState.wallets.length === 1) {
    ctx.session.bankLinking = { walletIndex: 0 };
    await ctx.scene.enter('bank_linking_scene');
    await ctx.answerCbQuery();
    return;
  }

  const keyboard = userState.wallets.map((wallet, index) => [
    Markup.button.callback(`Wallet ${index + 1} - ${wallet.chain}`, `edit_bank_wallet_${index}`)
  ]);
  keyboard.push([Markup.button.callback('🔙 Back to Settings', 'settings_back_main')]);

  await ctx.replyWithMarkdown(userState.usePidgin
    ? '🏦 Pick wallet to edit bank details:'
    : '🏦 Select wallet to edit bank details:', Markup.inlineKeyboard(keyboard));
  await ctx.answerCbQuery();
});

bot.action(/edit_bank_wallet_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);
  const userState = await getUserState(userId);

  if (walletIndex >= userState.wallets.length) {
    const errorMsg = userState.usePidgin
      ? '❌ Wallet no dey. Try again.'
      : '❌ Invalid wallet. Please try again.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
    return;
  }

  ctx.session.bankLinking = { walletIndex };
  await ctx.scene.enter('bank_linking_scene');
  await ctx.answerCbQuery();
});

bot.action('settingsrename_wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  if (userState.wallets.length === 0) {
    const errorMsg = userState.usePidgin
      ? '❌ No wallet to rename. Generate one first.'
      : '❌ No wallets to rename. Generate one first.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
    return;
  }

  const keyboard = userState.wallets.map((wallet, index) => [
    Markup.button.callback(`Wallet ${index + 1} - ${wallet.chain}`, `rename_wallet_${index}`)
  ]);
  keyboard.push([Markup.button.callback('🔙 Back to Settings', 'settings_back_main')]);

  await ctx.replyWithMarkdown(userState.usePidgin
    ? '📝 Pick wallet to rename:'
    : '📝 Select wallet to rename:', Markup.inlineKeyboard(keyboard));
  await ctx.answerCbQuery();
});

bot.action(/rename_wallet_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);
  const userState = await getUserState(userId);

  if (walletIndex >= userState.wallets.length) {
    const errorMsg = userState.usePidgin
      ? '❌ Wallet no dey. Try again.'
      : '❌ Invalid wallet. Please try again.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
    return;
  }

  ctx.session.renameWallet = { walletIndex };
  await ctx.replyWithMarkdown(userState.usePidgin
    ? '📝 Enter new name for this wallet (e.g., My Main Wallet):'
    : '📝 Enter a new name for this wallet (e.g., My Main Wallet):');
  await ctx.answerCbQuery();
});

bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  if (ctx.session.renameWallet) {
    const newName = ctx.message.text.trim();
    if (newName.length > 50) {
      await ctx.replyWithMarkdown(userState.usePidgin
        ? '❌ Name too long. Keep am under 50 characters.'
        : '❌ Name too long. Please keep it under 50 characters.');
      return;
    }

    const walletIndex = ctx.session.renameWallet.walletIndex;
    userState.wallets[walletIndex].name = newName;
    await updateUserState(userId, { wallets: userState.wallets });

    await ctx.replyWithMarkdown(userState.usePidgin
      ? `✅ Wallet ${walletIndex + 1} don rename to *${newName}*!`
      : `✅ Wallet ${walletIndex + 1} renamed to *${newName}*!`);
    delete ctx.session.renameWallet;
    logger.info(`User ${userId} renamed wallet ${walletIndex + 1} to ${newName}`);
  }
});

bot.action('settings_set_refund_address', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  await ctx.replyWithMarkdown(userState.usePidgin
    ? '🔙 Enter your refund wallet address (EVM or Solana). This na where we go send funds if payout fail:'
    : '🔙 Enter your refund wallet address (EVM or Solana). This is where funds will be sent if a payout fails:');
  ctx.session.setRefundAddress = true;
  await ctx.answerCbQuery();
});

bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  if (ctx.session.setRefundAddress) {
    const address = ctx.message.text.trim();
    const isValidEvmAddress = ethers.utils.isAddress(address);
    const isValidSolanaAddress = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);

    if (!isValidEvmAddress && !isValidSolanaAddress) {
      await ctx.replyWithMarkdown(userState.usePidgin
        ? '❌ Address no correct. Enter valid EVM or Solana address.'
        : '❌ Invalid address. Please enter a valid EVM or Solana address.');
      return;
    }

    await updateUserState(userId, { refundAddress: address });
    await ctx.replyWithMarkdown(userState.usePidgin
      ? `✅ Refund address set to \`${address}\`!`
      : `✅ Refund address set to \`${address}\`!`);
    delete ctx.session.setRefundAddress;
    logger.info(`User ${userId} set refund address to ${address}`);
  }
});

bot.action('settings_support', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  const supportMessage = userState.usePidgin
    ? `ℹ️ *Support*\n\nYou get any issue or question? Contact our team:\n\n` +
      `👉 *Telegram:* [@maxcswap](https://t.me/maxcswap)\n` +
      `📩 *Your User ID:* \`${userId}\` (share this if you dey report issue)\n\n` +
      `We dey here to help you!`
    : `ℹ️ *Support*\n\nHave an issue or question? Reach out to our support team:\n\n` +
      `👉 *Telegram:* [@maxcswap](https://t.me/maxcswap)\n` +
      `📩 *Your User ID:* \`${userId}\` (please provide this when reporting issues)\n\n` +
      `We're here to assist you!`;

  await ctx.replyWithMarkdown(supportMessage);
  await ctx.answerCbQuery();
  logger.info(`User ${userId} accessed support from settings.`);
});

bot.action('settings_back_main', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  const settingsMessage = userState.usePidgin
    ? `⚙️ *Settings*\n\nPick option to manage your account:`
    : `⚙️ *Settings*\n\nChoose an option to manage your account:`;

  await ctx.editMessageText(settingsMessage, {
    parse_mode: 'Markdown',
    reply_markup: getSettingsMenu().reply_markup
  });
  if (isAdmin(userId)) {
    await ctx.replyWithMarkdown(userState.usePidgin
      ? `👨‍💼 *Admin Options*\n\nYou fit manage bot here:`
      : `👨‍💼 *Admin Options*\n\nManage bot operations below:`, getAdminMenu());
  }
  await ctx.answerCbQuery();
  logger.info(`User ${userId} returned to settings menu.`);
});

bot.action('admin_view_all_transactions', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    await ctx.replyWithMarkdown('❌ You no be admin.');
    await ctx.answerCbQuery();
    return;
  }

  try {
    const transactionsSnapshot = await db.collection('transactions')
      .orderBy('timestamp', 'desc')
      .limit(50)
      .get();

    if (transactionsSnapshot.empty) {
      await ctx.replyWithMarkdown('📋 No transactions found.');
      await ctx.answerCbQuery();
      return;
    }

    let message = '📋 *All Transactions (Last 50)*\n\n';
    transactionsSnapshot.forEach((doc) => {
      const tx = doc.data();
      message += `*Ref ID:* \`${tx.referenceId}\`\n` +
                `• *User ID:* ${tx.userId}\n` +
                `• *Amount:* ${tx.amount} ${tx.asset}\n` +
                `• *Payout:* ₦${tx.payoutAmount || 'N/A'}\n` +
                `• *Status:* ${tx.status}\n` +
                `• *Chain:* ${tx.chain}\n` +
                `• *Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n\n`;
    });

    await ctx.replyWithMarkdown(message);
    logger.info(`Admin ${userId} viewed all transactions.`);
  } catch (error) {
    logger.error(`Error fetching transactions for admin ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('❌ Error fetching transactions.');
  }
  await ctx.answerCbQuery();
});

bot.action('admin_view_users', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    await ctx.replyWithMarkdown('❌ You no be admin.');
    await ctx.answerCbQuery();
    return;
  }

  try {
    const usersSnapshot = await db.collection('users').limit(50).get();
    if (usersSnapshot.empty) {
      await ctx.replyWithMarkdown('👥 No users found.');
      await ctx.answerCbQuery();
      return;
    }

    let message = '👥 *All Users (Last 50)*\n\n';
    usersSnapshot.forEach((doc) => {
      const user = doc.data();
      message += `*User ID:* ${doc.id}\n` +
                `• *Name:* ${user.firstName || 'N/A'}\n` +
                `• *Wallets:* ${user.wallets.length}\n` +
                `• *Has Deposit:* ${user.hasReceivedDeposit ? 'Yes' : 'No'}\n\n`;
    });

    await ctx.replyWithMarkdown(message);
    logger.info(`Admin ${userId} viewed all users.`);
  } catch (error) {
    logger.error(`Error fetching users for admin ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('❌ Error fetching users.');
  }
  await ctx.answerCbQuery();
});

bot.action('admin_pending_issues', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    await ctx.replyWithMarkdown('❌ You no be admin.');
    await ctx.answerCbQuery();
    return;
  }

  try {
    const transactionsSnapshot = await db.collection('transactions')
      .where('status', 'in', ['Failed', 'Pending'])
      .orderBy('timestamp', 'desc')
      .limit(50)
      .get();

    if (transactionsSnapshot.empty) {
      await ctx.replyWithMarkdown('⏳ No pending or failed transactions.');
      await ctx.answerCbQuery();
      return;
    }

    let message = '⏳ *Pending/Failed Transactions*\n\n';
    transactionsSnapshot.forEach((doc) => {
      const tx = doc.data();
      message += `*Ref ID:* \`${tx.referenceId}\`\n` +
                `• *User ID:* ${tx.userId}\n` +
                `• *Amount:* ${tx.amount} ${tx.asset}\n` +
                `• *Status:* ${tx.status}\n` +
                `• *Chain:* ${tx.chain}\n` +
                `• *Failure Reason:* ${tx.failureReason || 'N/A'}\n\n`;
    });

    await ctx.replyWithMarkdown(message);
    logger.info(`Admin ${userId} viewed pending issues.`);
  } catch (error) {
    logger.error(`Error fetching pending issues for admin ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('❌ Error fetching pending issues.');
  }
  await ctx.answerCbQuery();
});

bot.action('admin_send_message', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    await ctx.replyWithMarkdown('❌ You no be admin.');
    await ctx.answerCbQuery();
    return;
  }

  await ctx.scene.enter('send_message_scene');
  await ctx.answerCbQuery();
});

bot.action('admin_manual_payout', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    await ctx.replyWithMarkdown('❌ You no be admin.');
    await ctx.answerCbQuery();
    return;
  }

  await ctx.replyWithMarkdown('💰 Enter transaction details for manual payout (format: UserID, Amount, Asset, RefID):');
  ctx.session.manualPayout = true;
  await ctx.answerCbQuery();
});

bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  if (ctx.session.manualPayout && isAdmin(userId)) {
    const input = ctx.message.text.trim().split(',');
    if (input.length !== 4) {
      await ctx.replyWithMarkdown('❌ Format no correct. Use: UserID, Amount, Asset, RefID');
      return;
    }

    const [targetUserId, amountStr, asset, referenceId] = input.map(s => s.trim());
    const amount = parseFloat(amountStr);

    if (!/^\d{5,15}$/.test(targetUserId)) {
      await ctx.replyWithMarkdown('❌ Invalid User ID.');
      return;
    }

    if (isNaN(amount) || amount <= 0) {
      await ctx.replyWithMarkdown('❌ Invalid amount.');
      return;
    }

    if (!SUPPORTED_ASSETS.includes(asset.toUpperCase())) {
      await ctx.replyWithMarkdown('❌ Invalid asset. Use USDC or USDT.');
      return;
    }

    try {
      const userDoc = await db.collection('users').doc(targetUserId).get();
      if (!userDoc.exists) {
        await ctx.replyWithMarkdown('❌ User not found.');
        return;
      }

      const userData = userDoc.data();
      const wallet = userData.wallets.find(w => w.bank);
      if (!wallet || !wallet.bank) {
        await ctx.replyWithMarkdown('❌ User has no linked bank account.');
        return;
      }

      const payoutAmount = calculatePayout(asset, amount);
      const order = await createPaycrestOrder(
        targetUserId,
        amount,
        asset,
        wallet.chain,
        wallet.bank,
        wallet.address
      );

      const transactionData = {
        userId: targetUserId,
        walletAddress: wallet.address,
        amount,
        asset,
        chain: wallet.chain,
        referenceId,
        status: 'Pending',
        payoutAmount,
        bankName: wallet.bank.bankName,
        accountNumber: wallet.bank.accountNumber,
        accountName: wallet.bank.accountName,
        paycrestOrderId: order.orderId,
        timestamp: new Date().toISOString()
      };

      await db.collection('transactions').add(transactionData);

      await ctx.replyWithMarkdown(`✅ Manual payout initiated for user ${targetUserId}:\n\n` +
        `*Ref ID:* ${referenceId}\n` +
        `*Amount:* ${amount} ${asset}\n` +
        `*Payout:* ₦${payoutAmount}`);
      await bot.telegram.sendMessage(targetUserId, `💰 *Manual Payout Initiated*\n\n` +
        `Admin has started a payout for you:\n\n` +
        `- *Amount:* ${amount} ${asset}\n` +
        `- *Payout:* ₦${payoutAmount}\n` +
        `- *Ref ID:* \`${referenceId}\`\n` +
        `- *Bank:* ${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)})\n\n` +
        `You will receive a confirmation soon.`, { parse_mode: 'Markdown' });

      logger.info(`Admin ${userId} initiated manual payout for user ${targetUserId}: ${amount} ${asset}, Ref: ${referenceId}`);
    } catch (error) {
      logger.error(`Error processing manual payout by admin ${userId}: ${error.message}`);
      await ctx.replyWithMarkdown('❌ Error processing manual payout.');
    } finally {
      delete ctx.session.manualPayout;
    }
  }
});

bot.action('admin_refund_tx', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    await ctx.replyWithMarkdown('❌ You no be admin.');
    await ctx.answerCbQuery();
    return;
  }

  await ctx.replyWithMarkdown('🔄 Enter transaction Ref ID to refund:');
  ctx.session.refundTx = true;
  await ctx.answerCbQuery();
});

bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  if (ctx.session.refundTx && isAdmin(userId)) {
    const refId = ctx.message.text.trim();

    try {
      const transactionDoc = await db.collection('transactions')
        .where('referenceId', '==', refId)
        .limit(1)
        .get();

      if (transactionDoc.empty) {
        await ctx.replyWithMarkdown('❌ Transaction not found.');
        return;
      }

      const transaction = transactionDoc.docs[0].data();
      if (transaction.status !== 'Failed') {
        await ctx.replyWithMarkdown('❌ Can only refund failed transactions.');
        return;
      }

      const targetUserId = transaction.userId;
      const userDoc = await db.collection('users').doc(targetUserId).get();
      if (!userDoc.exists) {
        await ctx.replyWithMarkdown('❌ User not found.');
        return;
      }

      const userData = userDoc.data();
      let refundAddress = userData.refundAddress || transaction.walletAddress;
      if (!refundAddress) {
        refundAddress = PAYCREST_RETURN_ADDRESS;
      }

      const chainData = chains[transaction.chain];
      const assetId = chainData.assets[transaction.asset];
      const reference = `REFUND_${refId}`;
      const metadata = { userId: targetUserId, originalTx: refId };

      await withdrawFromBlockradar(
        transaction.chain,
        assetId,
        refundAddress,
        transaction.amount,
        reference,
        metadata
      );

      await db.collection('transactions').doc(transactionDoc.docs[0].id).update({
        status: 'Refunded',
        refundAddress,
        refundTimestamp: new Date().toISOString()
      });

      await ctx.replyWithMarkdown(`✅ Refund processed for Ref ID \`${refId}\`:\n\n` +
        `*User ID:* ${targetUserId}\n` +
        `*Amount:* ${transaction.amount} ${transaction.asset}\n` +
        `*Refund To:* \`${refundAddress}\``);
      await bot.telegram.sendMessage(targetUserId, `🔄 *Transaction Refunded*\n\n` +
        `Your transaction has been refunded:\n\n` +
        `- *Ref ID:* \`${refId}\`\n` +
        `- *Amount:* ${transaction.amount} ${transaction.asset}\n` +
        `- *Refund Address:* \`${refundAddress}\`\n\n` +
        `Check your wallet. Contact [@maxcswap](https://t.me/maxcswap) if you need help.`, { parse_mode: 'Markdown' });

      logger.info(`Admin ${userId} refunded transaction ${refId} for user ${targetUserId}`);
    } catch (error) {
      logger.error(`Error processing refund by admin ${userId} for Ref ID ${refId}: ${error.message}`);
      await ctx.replyWithMarkdown('❌ Error processing refund.');
    } finally {
      delete ctx.session.refundTx;
    }
  }
});

bot.action('admin_api_status', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    await ctx.replyWithMarkdown('❌ You no be admin.');
    await ctx.answerCbQuery();
    return;
  }

  try {
    const statusMessage = `⚠️ *API/Bot Status*\n\n` +
      `• *Bot Running:* ✅\n` +
      `• *Exchange Rates:* \n` +
      `${SUPPORTED_ASSETS.map(asset => `  - ${asset}: ₦${exchangeRates[asset] || 'N/A'}`).join('\n')}\n` +
      `• *Last Rate Update:* ${new Date().toLocaleString()}\n` +
      `• *Webhook Status:* ${WEBHOOK_DOMAIN ? '✅ Configured' : '⚠️ Not set'}\n` +
      `• *Firebase:* ✅ Connected`;

    await ctx.replyWithMarkdown(statusMessage);
    logger.info(`Admin ${userId} checked API/bot status.`);
  } catch (error) {
    logger.error(`Error checking API status for admin ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('❌ Error checking status.');
  }
  await ctx.answerCbQuery();
});

bot.action('admin_back_to_main', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  const settingsMessage = userState.usePidgin
    ? `⚙️ *Settings*\n\nPick option to manage your account:`
    : `⚙️ *Settings*\n\nChoose an option to manage your account:`;

  await ctx.editMessageText(settingsMessage, {
    parse_mode: 'Markdown',
    reply_markup: getSettingsMenu().reply_markup
  });
  await ctx.replyWithMarkdown(userState.usePidgin
    ? `👨‍💼 *Admin Options*\n\nYou fit manage bot here:`
    : `👨‍💼 *Admin Options*\n\nManage bot operations below:`, getAdminMenu());
  await ctx.answerCbQuery();
  logger.info(`Admin ${userId} returned to admin menu.`);
});

bot.action(/export_receipt_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);
  const userState = await getUserState(userId);

  try {
    const wallet = userState.wallets[walletIndex];
    if (!wallet) {
      await ctx.replyWithMarkdown(userState.usePidgin
        ? '❌ Wallet no dey.'
        : '❌ Invalid wallet.');
      await ctx.answerCbQuery();
      return;
    }

    const transactionsSnapshot = await db.collection('transactions')
      .where('walletAddress', 'in', [wallet.address, wallet.solanaAddress])
      .orderBy('timestamp', 'desc')
      .limit(10)
      .get();

    if (transactionsSnapshot.empty) {
      await ctx.replyWithMarkdown(userState.usePidgin
        ? '❌ No transactions for this wallet.'
        : '❌ No transactions found for this wallet.');
      await ctx.answerCbQuery();
      return;
    }

    let receiptText = `DirectPay Transaction Receipt\n` +
                     `Wallet ${walletIndex + 1} - ${wallet.chain}\n\n`;
    transactionsSnapshot.forEach((doc) => {
      const tx = doc.data();
      receiptText += `Transaction ${tx.referenceId || 'N/A'}:\n` +
                    `Reference ID: ${tx.referenceId || 'N/A'}\n` +
                    `Amount: ${tx.amount || 'N/A'} ${tx.asset || 'N/A'}\n` +
                    `Status: ${tx.status || 'Pending'}\n` +
                    `Rate: ₦${exchangeRates[tx.asset] || 'N/A'} per ${tx.asset || 'N/A'}\n` +
                    `Date: ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n` +
                    `Chain: ${tx.chain || 'N/A'}\n\n`;
    });

    const filePath = path.join(__dirname, `receipt_${userId}_${Date.now()}.txt`);
    await fs.promises.writeFile(filePath, receiptText);

    await ctx.replyWithDocument({
      source: createReadStream(filePath),
      filename: `DirectPay_Receipt_Wallet${walletIndex + 1}.txt`
    });

    await unlinkAsync(filePath);
    logger.info(`User ${userId} exported receipt for wallet ${walletIndex + 1}`);
  } catch (error) {
    logger.error(`Error exporting receipt for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown(userState.usePidgin
      ? '❌ Error exporting receipt.'
      : '❌ Failed to export receipt.');
  }
  await ctx.answerCbQuery();
});

// Start Express Server
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});

// Handle Bot Shutdown
process.on('SIGINT', async () => {
  logger.info('Shutting down bot...');
  await bot.stop();
  process.exit(0);
});
