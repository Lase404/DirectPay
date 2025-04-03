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
const ethers = require('ethers'); // Added for wallet generation if needed
require('dotenv').config(); // Load environment variables from .env file

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
        refundAddress: null // Added for refund address
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
        ? `❌ Bank name no match o. Check your spelling or try:\n\n${bankList.map(b => `• ${b.name}`).join('\n')}\n\nTry again or type "exit" to stop.`
        : `❌ No matching bank found. Check your spelling or try:\n\n${bankList.map(b => `• ${b.name}`).join('\n')}\n\nTry again or type "exit" to cancel.`;
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
      reply_markup: getMainMenu(true, true)
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
  const retryMsg = userState.usePidgin
    ? '⚠️ Let’s start over. Enter your bank name again (e.g., GTBank, Access):'
    : '⚠️ Let\'s try again. Please enter your bank name again (e.g., GTBank, Access):';
  await ctx.replyWithMarkdown(retryMsg);
  ctx.session.bankData = {};
  ctx.session.bankData.step = 1;
  await ctx.answerCbQuery();
  ctx.wizard.selectStep(1);
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
        ? '📥 Click to export receipt as text:'
        : '📥 Click to export this receipt as text:';
      await ctx.replyWithMarkdown(receiptMessage + exportMsg, Markup.inlineKeyboard([
        [Markup.button.callback('📤 Export', `export_receipt_${walletIndex}`)]
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

// =================== Register Scenes with Stage ===================
const stage = new Scenes.Stage();
stage.register(bankLinkingScene, sendMessageScene, receiptGenerationScene);
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
app.use(requestIp.mw());
app.post(WEBHOOK_PAYCREST_PATH, bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  // Paycrest webhook handler moved here to ensure raw body parsing comes first
  await handlePaycrestWebhook(req, res);
});
app.use(bodyParser.json());

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
setInterval(fetchExchangeRates, 300000); // 5 minutes

// =================== Main Menu ===================
const getMainMenu = (walletExists, hasBankLinked) =>
  Markup.keyboard([
    [walletExists ? "💼 View Wallet" : "💼 Generate Wallet", "⚙️ Settings"],
    ["💰 Transactions", "📘 Learn About Base", "ℹ️ Support"],
    ["📈 View Current Rates"],
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
      ? `👋 Welcome back, ${userState.firstName}!\n\nThis na **DirectPay**, your crypto-to-cash plug.\n\n💡 *How to Start:*\n1. Link bank with "⚙️ Settings"\n2. Check your wallet address\n3. Send stablecoins, get cash fast.\n\nRates dey fresh, money dey safe!\n\n*Refund Address:* Set one in "⚙️ Settings" if payout fail (default na your wallet).`
      : `👋 Welcome back, ${userState.firstName}!\n\nThis is **DirectPay**, your crypto-to-cash solution.\n\n💡 *Quick Start:*\n1. Link your bank in "⚙️ Settings"\n2. View your wallet address\n3. Send stablecoins, receive cash quickly.\n\nRates are updated, funds are secure!\n\n*Refund Address:* Set one in "⚙️ Settings" for failed payouts (defaults to your wallet).`
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

  // Check if user is in bank_linking_scene
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
        walletAddresses: userState.wallets.map(w => w.address), // Fixed typo here
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
          `Let’s link your bank now to start using it.\n\n*Refund Address:* Set one in "⚙️ Settings" if payout fail (default na this wallet).`
        : `✅ *Wallet Generated*\n\n` +
          `*Networks:* Base, BNB Smart Chain, Polygon (EVM Compatible)\n` +
          `*Assets:* USDC, USDT\n` +
          `*Address:* \`${walletAddress}\`\n\n` +
          `Let’s link your bank now to start using it.\n\n*Refund Address:* Set one in "⚙️ Settings" for failed payouts (defaults to this wallet).`;
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

  const navigationButtons = [];
  if (page > 1) navigationButtons.push(Markup.button.callback('⬅️ Previous', `tx_page_${page - 1}_${filterDescription.replace(/\s/g, '_')}`));
  if (page < totalPages) navigationButtons.push(Markup.button.callback('Next ➡️', `tx_page_${page + 1}_${filterDescription.replace(/\s/g, '_')}`));
  navigationButtons.push(Markup.button.callback('🔄 Refresh', `tx_page_${page}_${filterDescription.replace(/\s/g, '_')}`));
  navigationButtons.push(Markup.button.callback('🏠 Exit', 'tx_exit'));

  const inlineKeyboard = Markup.inlineKeyboard([navigationButtons]);
  await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: inlineKeyboard.reply_markup });
}

// =================== Transaction Action Handlers ===================
bot.action('tx_all', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const query = db.collection('transactions')
      .where('userId', '==', userId)
      .orderBy('timestamp', 'desc');
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
  try {
    const query = db.collection('transactions')
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
  const prompt = userState.usePidgin
    ? '🪙 Pick asset to filter:'
    : '🪙 Select asset to filter by:';
  await ctx.editMessageText(prompt, {
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback('USDC', 'tx_asset_USDC')],
      [Markup.button.callback('USDT', 'tx_asset_USDT')],
      [Markup.button.callback('🔙 Back', 'tx_back')]
    ]).reply_markup
  });
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
  await ctx.editMessageText(prompt, {
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard(months).reply_markup
  });
  ctx.answerCbQuery();
});

bot.action(/tx_date_(.+)_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const month = ctx.match[1];
  const year = parseInt(ctx.match[2], 10);
  try {
    const startDate = new Date(`${month} 1, ${year}`);
    const endDate = new Date(year, startDate.getMonth() + 1, 0, 23, 59, 59, 999);

    const query = db.collection('transactions')
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

bot.action('tx_exit', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  await greetUser(ctx);
  ctx.answerCbQuery();
});

bot.action(/tx_page_(\d+)_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const page = parseInt(ctx.match[1], 10);
  const filterDescription = ctx.match[2].replace(/_/g, ' ');

  try {
    let query = db.collection('transactions')
      .where('userId', '==', userId)
      .orderBy('timestamp', 'desc');

    if (filterDescription.includes('Completed') || filterDescription.includes('Failed') || 
        filterDescription.includes('Pending') || filterDescription.includes('Refunded')) {
      const status = filterDescription.split(' - ')[1].replace(' Transactions', '');
      query = query.where('status', '==', status);
    } else if (filterDescription.includes('USDC') || filterDescription.includes('USDT')) {
      const asset = filterDescription.split(' - ')[1].replace(' Transactions', '');
      query = query.where('asset', '==', asset);
    } else if (filterDescription.match(/\w+ \d{4}/)) {
      const [month, year] = filterDescription.split(' - ')[1].split(' ');
      const startDate = new Date(`${month} 1, ${year}`);
      const endDate = new Date(year, startDate.getMonth() + 1, 0, 23, 59, 59, 999);
      query = query.where('timestamp', '>=', startDate.toISOString())
                   .where('timestamp', '<=', endDate.toISOString());
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
  const supportMsg = userState.usePidgin
    ? '🛠️ *Support*\n\nNeed help? Pick one:\n\n• How It Works\n• Transaction No Show\n• Contact Us'
    : '🛠️ *Support*\n\nNeed assistance? Choose an option:\n\n• How It Works\n• Transaction Not Received\n• Contact Us';
  await ctx.replyWithMarkdown(supportMsg, Markup.inlineKeyboard([
    [Markup.button.callback('❓ How It Works', 'support_how_it_works')],
    [Markup.button.callback('⚠️ Transaction Not Received', 'support_not_received')],
    [Markup.button.callback('💬 Contact Us', 'support_contact')]
  ]));
});

bot.action('support_how_it_works', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const howItWorksMsg = userState.usePidgin
    ? '📖 *How DirectPay Work*\n\n1. Generate wallet\n2. Link bank\n3. Send USDC/USDT\n4. Get Naira fast\n\nSimple as that!'
    : '📖 *How DirectPay Works*\n\n1. Generate a wallet\n2. Link your bank\n3. Send USDC/USDT\n4. Receive Naira quickly\n\nThat’s it!';
  await ctx.editMessageText(howItWorksMsg, { parse_mode: 'Markdown', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'support_back')]]).reply_markup });
  ctx.answerCbQuery();
});

bot.action('support_not_received', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const notReceivedMsg = userState.usePidgin
    ? '⚠️ *Transaction No Show*\n\nSend your Ref ID to [@maxcswap](https://t.me/maxcswap). We go check am fast.'
    : '⚠️ *Transaction Not Received*\n\nPlease send your Reference ID to [@maxcswap](https://t.me/maxcswap). We’ll check it quickly.';
  await ctx.editMessageText(notReceivedMsg, { parse_mode: 'Markdown', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'support_back')]]).reply_markup });
  ctx.answerCbQuery();
});

bot.action('support_contact', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const contactMsg = userState.usePidgin
    ? '💬 *Contact Us*\n\nReach us at [@maxcswap](https://t.me/maxcswap) for any wahala.'
    : '💬 *Contact Us*\n\nReach out to us at [@maxcswap](https://t.me/maxcswap) for any issues.';
  await ctx.editMessageText(contactMsg, { parse_mode: 'Markdown', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'support_back')]]).reply_markup });
  ctx.answerCbQuery();
});

bot.action('support_back', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const supportMsg = userState.usePidgin
    ? '🛠️ *Support*\n\nNeed help? Pick one:\n\n• How It Works\n• Transaction No Show\n• Contact Us'
    : '🛠️ *Support*\n\nNeed assistance? Choose an option:\n\n• How It Works\n• Transaction Not Received\n• Contact Us';
  await ctx.editMessageText(supportMsg, {
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback('❓ How It Works', 'support_how_it_works')],
      [Markup.button.callback('⚠️ Transaction Not Received', 'support_not_received')],
      [Markup.button.callback('💬 Contact Us', 'support_contact')]
    ]).reply_markup
  });
  ctx.answerCbQuery();
});

// =================== Learn About Base Handler ===================
bot.hears('📘 Learn About Base', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  await displayLearnAboutBase(ctx, 1);
});

async function displayLearnAboutBase(ctx, page) {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  
  const pages = userState.usePidgin ? [
    '📘 *Wetin Be Base? (1/5)*\n\nBase na one sweet Ethereum Layer 2 chain wey Coinbase build. Imagine am like expressway for Ethereum—fast, cheap, and e dey dodge those crazy gas fees! E dey use Optimistic Rollups (fancy tech, abi?) to bundle transactions, so you fit do plenty things without breaking bank. Na game-changer for crypto lovers!',
    '📘 *How Base Start? (2/5)*\n\nBase no just fall from sky o! Coinbase, those big crypto guys, team up with Optimism (OP Stack) to born this chain in 2023. Dem say, "Why we go dey pay high gas fees when we fit build something better?" Now, Base dey live, dey breathe, and e dey carry thousands of transactions every day. E be like Ethereum’s fine younger brother!',
    '📘 *Wetin Base Fit Do? (3/5)*\n\nBase no dey play small! E dey support USDC and USDT—stablecoins wey you fit use send money quick-quick with small-small cost. You wan swap tokens? Trade NFT? Run DeFi app? Base get you covered! E dey process transactions off-chain, then report back to Ethereum, so everything stay secure but fast like Usain Bolt!',
    '📘 *Why Base Dey Hot? (4/5)*\n\nWhy people dey rush Base? Number one: e cheap—gas fees wey no go make you cry. Number two: e fast—transactions dey fly like jet. Number three: e secure—Ethereum dey back am up like big boss. Plus, e dey open for developers to build mad apps. Na why Base dey grow like wildfire for crypto space!',
    '📘 *Base Fun Facts & Future (5/5)*\n\nYou sabi say Base don handle millions of transactions since e land? E dey power big projects like Uniswap and Aave! And the future? E go dey bigger—more apps, more users, more vibes. Whether you dey move crypto-to-cash or you just wan flex with NFT, Base na your guy. Join the party now!'
  ] : [
    // Page 1
    '📘 *What is Base? (1/5)*\n\nBase is an Ethereum Layer 2 chain cooked up by Coinbase, and it’s a total vibe! Think of it as a turbocharged sidekick to Ethereum—blazing fast, super cheap, and it saves you from those wild gas fees. Using Optimistic Rollups (tech wizardry!), it bundles transactions to keep costs low and speed high. Crypto just got a lot more fun!',

    '📘 *How Did Base Come to Life? (2/5)*\n\nBase didn’t just pop out of nowhere! In 2023, Coinbase teamed up with the Optimism crew (OP Stack) to launch this bad boy. They were tired of Ethereum’s high fees and slow vibes, so they built a lean, mean transaction machine. Now, Base is thriving, handling thousands of transactions daily—like Ethereum’s cooler, younger sibling!',

    '📘 *What Can Base Do? (3/5)*\n\nBase is a jack-of-all-trades! It supports USDC and USDT, letting you send cash fast with fees so tiny you’ll barely notice. Want to swap tokens? Trade NFTs? Dive into DeFi? Base has your back! It processes everything off-chain, then syncs with Ethereum for security. It’s like having a Ferrari with a vault for a trunk!',

    '📘 *Why’s Base So Popular? (4/5)*\n\nWhy’s everyone obsessed with Base? First, it’s cheap—gas fees won’t drain your wallet. Second, it’s fast—transactions zoom by in a flash. Third, it’s secure—Ethereum’s got its back like a trusty bodyguard. Plus, developers love it for building wild apps. No wonder Base is the hottest thing in crypto right now!',

    '📘 *Fun Facts & The Future of Base (5/5)*\n\nDid you know Base has already processed millions of transactions? It’s powering giants like Uniswap and Aave! Looking ahead, it’s only getting bigger—more apps, more users, more excitement. Whether you’re cashing out crypto or flexing with NFTs, Base is your ticket to the future. Hop on board and enjoy the ride!'
  ];

  const totalPages = pages.length;
  if (page < 1 || page > totalPages) {
    await ctx.replyWithMarkdown('❌ Page no dey.' || '❌ Page not found.');
    return;
  }

  const navigationButtons = [];
  if (page > 1) navigationButtons.push(Markup.button.callback('⬅️ Previous', `learn_base_page_${page - 1}`));
  if (page < totalPages) navigationButtons.push(Markup.button.callback('Next ➡️', `learn_base_page_${page + 1}`));
  navigationButtons.push(Markup.button.callback('🏠 Main Menu', 'back_to_main'));

  const message = pages[page - 1];
  await ctx.replyWithMarkdown(message, Markup.inlineKeyboard([navigationButtons]));
}

bot.action(/learn_base_page_(\d+)/, async (ctx) => {
  const page = parseInt(ctx.match[1], 10);
  await displayLearnAboutBase(ctx, page);
  ctx.answerCbQuery();
});

bot.action('back_to_main', async (ctx) => {
  await greetUser(ctx);
  ctx.answerCbQuery();
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
    ? '\nThese rates go work for your deposits and payouts.'
    : '\nThese rates apply to your deposits and payouts.';
  await ctx.replyWithMarkdown(ratesMessage);
});

// =================== Settings Handler ===================
bot.action('settings_set_refund_address', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const refundPrompt = userState.usePidgin
    ? '🔙 *Set Refund Address*\n\nEnter address where we go send funds if payout fail (e.g., 0x...). Type "default" to use wallet address:'
    : '🔙 *Set Refund Address*\n\nEnter the address where funds should be sent if a payout fails (e.g., 0x...). Type "default" to use your wallet address:';
  await ctx.replyWithMarkdown(refundPrompt);
  ctx.session.awaitingRefundAddress = true;
  ctx.answerCbQuery();
});


  
bot.hears('⚙️ Settings', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const settingsMsg = userState.usePidgin
    ? '⚙️ *Settings*\n\nPick one:'
    : '⚙️ *Settings*\n\nSelect an option:';
  await ctx.replyWithMarkdown(settingsMsg, getSettingsMenu());
});

bot.action(/settings_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const action = ctx.match[1];
  const userState = await getUserState(userId);

  switch (action) {
    case 'generate_wallet':
      try {
        if (userState.wallets.length >= MAX_WALLETS) {
          const errorMsg = userState.usePidgin
            ? `⚠️ You don reach max wallets (${MAX_WALLETS}). Check your wallets first.`
            : `⚠️ You’ve reached the max wallet limit (${MAX_WALLETS}). Check your existing wallets first.`;
          await ctx.replyWithMarkdown(errorMsg);
          return ctx.answerCbQuery();
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
              `Let’s link your bank now to start using it.\n\n*Refund Address:* Set one in "⚙️ Settings" if payout fail (default na this wallet).`
            : `✅ *Wallet Generated*\n\n` +
              `*Networks:* Base, BNB Smart Chain, Polygon (EVM Compatible)\n` +
              `*Assets:* USDC, USDT\n` +
              `*Address:* \`${walletAddress}\`\n\n` +
              `Let’s link your bank now to start using it.\n\n*Refund Address:* Set one in "⚙️ Settings" for failed payouts (defaults to this wallet).`;
          await ctx.replyWithMarkdown(successMsg);
          await ctx.scene.enter('bank_linking_scene');
          ctx.answerCbQuery();
        } catch (error) {
          logger.error(`Error generating wallet in settings for user ${userId}: ${error.message}`);
          const errorMsg = userState.usePidgin
            ? '❌ Problem dey. Try again later.'
            : '❌ Something went wrong. Please try again later.';
          await ctx.replyWithMarkdown(errorMsg);
          await ctx.deleteMessage(generatingMessage.message_id);
          ctx.answerCbQuery();
        }
      } catch (error) {
        logger.error(`Error initiating wallet generation in settings for user ${userId}: ${error.message}`);
        const errorMsg = userState.usePidgin
          ? '❌ E no work. Try again later.'
          : '❌ Failed to start wallet generation. Try again later.';
        await ctx.replyWithMarkdown(errorMsg);
        ctx.answerCbQuery();
      }
      break;

    case 'edit_bank':
      if (userState.wallets.length === 0) {
        const errorMsg = userState.usePidgin
          ? '❌ No wallet dey. Generate one first.'
          : '❌ No wallets found. Generate one first.';
        await ctx.replyWithMarkdown(errorMsg);
        ctx.answerCbQuery();
        return;
      }
      const walletButtons = userState.wallets.map((wallet, index) => [
        Markup.button.callback(`Wallet ${index + 1} - ${wallet.chain} (${wallet.bank ? 'Linked' : 'Not Linked'})`, `edit_bank_${index}`)
      ]);
      await ctx.replyWithMarkdown(userState.usePidgin
        ? '🏦 *Edit Bank Details*\n\nPick wallet to link or edit bank:'
        : '🏦 *Edit Bank Details*\n\nSelect a wallet to link or edit bank details:', Markup.inlineKeyboard(walletButtons));
      ctx.answerCbQuery();
      break;

    case 'rename_wallet':
      if (userState.wallets.length === 0) {
        const errorMsg = userState.usePidgin
          ? '❌ No wallet dey. Generate one first.'
          : '❌ No wallets found. Generate one first.';
        await ctx.replyWithMarkdown(errorMsg);
        ctx.answerCbQuery();
        return;
      }
      const renameButtons = userState.wallets.map((wallet, index) => [
        Markup.button.callback(`Wallet ${index + 1} - ${wallet.chain} (${wallet.name || 'Unnamed'})`, `rename_wallet_${index}`)
      ]);
      await ctx.replyWithMarkdown(userState.usePidgin
        ? '📝 *Rename Wallet*\n\nPick wallet to rename:'
        : '📝 *Rename Wallet*\n\nSelect a wallet to rename:', Markup.inlineKeyboard(renameButtons));
      ctx.answerCbQuery();
      break;

    case 'support':
      const supportMsg = userState.usePidgin
        ? '💬 *Support*\n\nContact [@maxcswap](https://t.me/maxcswap) for any wahala.'
        : '💬 *Support*\n\nContact [@maxcswap](https://t.me/maxcswap) for any issues.';
      await ctx.replyWithMarkdown(supportMsg);
      ctx.answerCbQuery();
      break;

    case 'back_main':
      await greetUser(ctx);
      ctx.answerCbQuery();
      break;

    default:
      await ctx.replyWithMarkdown(userState.usePidgin
        ? '❌ Option no dey. Try again.'
        : '❌ Invalid option. Try again.');
      ctx.answerCbQuery();
      break;
  }
});

bot.action(/edit_bank_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);
  const userState = await getUserState(userId);

  if (isNaN(walletIndex) || walletIndex < 0 || walletIndex >= userState.wallets.length) {
    const errorMsg = userState.usePidgin
      ? '❌ Wallet no dey. Pick correct one.'
      : '❌ Invalid wallet selection. Choose a valid wallet.';
    await ctx.replyWithMarkdown(errorMsg);
    ctx.answerCbQuery();
    return;
  }

  ctx.session.walletIndex = walletIndex;
  await ctx.scene.enter('bank_linking_scene');
  ctx.answerCbQuery();
});

bot.action(/rename_wallet_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);
  const userState = await getUserState(userId);

  if (isNaN(walletIndex) || walletIndex < 0 || walletIndex >= userState.wallets.length) {
    const errorMsg = userState.usePidgin
      ? '❌ Wallet no dey. Pick correct one.'
      : '❌ Invalid wallet selection. Choose a valid wallet.';
    await ctx.replyWithMarkdown(errorMsg);
    ctx.answerCbQuery();
    return;
  }

  ctx.session.walletIndex = walletIndex;
  const prompt = userState.usePidgin
    ? `📝 Enter new name for Wallet ${walletIndex + 1} - ${userState.wallets[walletIndex].chain}:`
    : `📝 Enter a new name for Wallet ${walletIndex + 1} - ${userState.wallets[walletIndex].chain}:`;
  await ctx.replyWithMarkdown(prompt);
  ctx.session.awaitingWalletName = true;
  ctx.answerCbQuery();
});


// =================== Admin Panel Handlers ===================
bot.action('open_admin_panel', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    await ctx.replyWithMarkdown('❌ You no be admin.');
    ctx.answerCbQuery();
    return;
  }

  if (ctx.session.adminMessageId) {
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.adminMessageId, null, '🔧 *Admin Panel*\n\nPick an option:', {
        parse_mode: 'Markdown',
        reply_markup: getAdminMenu().reply_markup
      });
    } catch (error) {
      logger.error(`Error editing admin panel message for ${userId}: ${error.message}`);
      const sentMessage = await ctx.replyWithMarkdown('🔧 *Admin Panel*\n\nPick an option:', getAdminMenu());
      ctx.session.adminMessageId = sentMessage.message_id;
    }
  } else {
    const sentMessage = await ctx.replyWithMarkdown('🔧 *Admin Panel*\n\nPick an option:', getAdminMenu());
    ctx.session.adminMessageId = sentMessage.message_id;
  }
  ctx.answerCbQuery();
});

bot.action('admin_view_all_transactions', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    await ctx.replyWithMarkdown('❌ You no be admin.');
    ctx.answerCbQuery();
    return;
  }

  const pageSize = 5;
  const page = ctx.session.adminTxPage || 1;
  const query = db.collection('transactions').orderBy('timestamp', 'desc');
  const transactionsSnapshot = await query.limit(pageSize).offset((page - 1) * pageSize).get();
  const totalDocsSnapshot = await query.count().get();
  const totalDocs = totalDocsSnapshot.data().count;
  const totalPages = Math.max(1, Math.ceil(totalDocs / pageSize));

  let message = `📋 *All Transactions* (Page ${page}/${totalPages})\n\n`;
  if (transactionsSnapshot.empty) {
    message += 'No transactions yet.';
  } else {
    transactionsSnapshot.forEach((doc) => {
      const tx = doc.data();
      message += `*Ref ID:* \`${tx.referenceId || 'N/A'}\`\n` +
                 `• *User:* ${tx.userId}\n` +
                 `• *Asset:* ${tx.asset || 'N/A'}\n` +
                 `• *Amount:* ${tx.amount || 'N/A'}\n` +
                 `• *Payout:* ₦${tx.payout || 'N/A'}\n` +
                 `• *Status:* ${tx.status || 'Pending'}\n` +
                 `• *Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleDateString() : 'N/A'}\n\n`;
    });
  }

  const navigationButtons = [];
  if (page > 1) navigationButtons.push(Markup.button.callback('⬅️ Previous', `admin_tx_page_${page - 1}`));
  if (page < totalPages) navigationButtons.push(Markup.button.callback('Next ➡️', `admin_tx_page_${page + 1}`));
  navigationButtons.push(Markup.button.callback('🔙 Back', 'admin_back_to_main'));

  await ctx.editMessageText(message, {
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard([navigationButtons]).reply_markup
  });
  ctx.answerCbQuery();
});

bot.action(/admin_tx_page_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    await ctx.replyWithMarkdown('❌ You no be admin.');
    ctx.answerCbQuery();
    return;
  }

  const page = parseInt(ctx.match[1], 10);
  ctx.session.adminTxPage = page;
  const pageSize = 5;
  const query = db.collection('transactions').orderBy('timestamp', 'desc');
  const transactionsSnapshot = await query.limit(pageSize).offset((page - 1) * pageSize).get();
  const totalDocsSnapshot = await query.count().get();
  const totalDocs = totalDocsSnapshot.data().count;
  const totalPages = Math.max(1, Math.ceil(totalDocs / pageSize));

  let message = `📋 *All Transactions* (Page ${page}/${totalPages})\n\n`;
  if (transactionsSnapshot.empty) {
    message += 'No transactions yet.';
  } else {
    transactionsSnapshot.forEach((doc) => {
      const tx = doc.data();
      message += `*Ref ID:* \`${tx.referenceId || 'N/A'}\`\n` +
                 `• *User:* ${tx.userId}\n` +
                 `• *Asset:* ${tx.asset || 'N/A'}\n` +
                 `• *Amount:* ${tx.amount || 'N/A'}\n` +
                 `• *Payout:* ₦${tx.payout || 'N/A'}\n` +
                 `• *Status:* ${tx.status || 'Pending'}\n` +
                 `• *Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleDateString() : 'N/A'}\n\n`;
    });
  }

  const navigationButtons = [];
  if (page > 1) navigationButtons.push(Markup.button.callback('⬅️ Previous', `admin_tx_page_${page - 1}`));
  if (page < totalPages) navigationButtons.push(Markup.button.callback('Next ➡️', `admin_tx_page_${page + 1}`));
  navigationButtons.push(Markup.button.callback('🔙 Back', 'admin_back_to_main'));

  await ctx.editMessageText(message, {
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard([navigationButtons]).reply_markup
  });
  ctx.answerCbQuery();
});

bot.action('admin_view_users', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    await ctx.replyWithMarkdown('❌ You no be admin.');
    ctx.answerCbQuery();
    return;
  }

  const usersSnapshot = await db.collection('users').get();
  let message = '👥 *All Users*\n\n';
  if (usersSnapshot.empty) {
    message += 'No users yet.';
  } else {
    usersSnapshot.forEach((doc) => {
      const user = doc.data();
      message += `*User ID:* ${doc.id}\n` +
                 `• *Name:* ${user.firstName || 'Unknown'}\n` +
                 `• *Wallets:* ${user.wallets.length}\n` +
                 `• *Refund Address:* ${user.refundAddress || 'Default (Wallet)'}\n\n`;
    });
  }

  await ctx.editMessageText(message, {
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'admin_back_to_main')]]).reply_markup
  });
  ctx.answerCbQuery();
});

bot.action('admin_pending_issues', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    await ctx.replyWithMarkdown('❌ You no be admin.');
    ctx.answerCbQuery();
    return;
  }

  const pendingSnapshot = await db.collection('transactions')
    .where('status', 'in', ['Pending', 'Failed'])
    .orderBy('timestamp', 'desc')
    .limit(10)
    .get();

  let message = '⏳ *Pending/Failed Transactions*\n\n';
  if (pendingSnapshot.empty) {
    message += 'No pending or failed transactions.';
  } else {
    pendingSnapshot.forEach((doc) => {
      const tx = doc.data();
      message += `*Ref ID:* \`${tx.referenceId || 'N/A'}\`\n` +
                 `• *User:* ${tx.userId}\n` +
                 `• *Amount:* ${tx.amount || 'N/A'} ${tx.asset || 'N/A'}\n` +
                 `• *Status:* ${tx.status}\n` +
                 `• *Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleDateString() : 'N/A'}\n\n`;
    });
  }

  await ctx.editMessageText(message, {
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'admin_back_to_main')]]).reply_markup
  });
  ctx.answerCbQuery();
});

bot.action('admin_send_message', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    await ctx.replyWithMarkdown('❌ You no be admin.');
    ctx.answerCbQuery();
    return;
  }

  await ctx.scene.enter('send_message_scene');
  ctx.answerCbQuery();
});

bot.action('admin_manual_payout', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    await ctx.replyWithMarkdown('❌ You no be admin.');
    ctx.answerCbQuery();
    return;
  }

  const prompt = '💰 *Manual Payout*\n\nEnter: `<User ID> <Amount> <Asset> <Reference ID>`\nE.g., `123456789 100 USDT REF-ABC123`';
  await ctx.replyWithMarkdown(prompt);
  ctx.session.awaitingManualPayout = true;
  ctx.answerCbQuery();
});

bot.action('admin_refund_tx', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    await ctx.replyWithMarkdown('❌ You no be admin.');
    ctx.answerCbQuery();
    return;
  }

  const prompt = '🔄 *Refund Transaction*\n\nEnter the Reference ID to refund:';
  await ctx.replyWithMarkdown(prompt);
  ctx.session.awaitingRefundTx = true;
  ctx.answerCbQuery();
});

bot.action('admin_api_status', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    await ctx.replyWithMarkdown('❌ You no be admin.');
    ctx.answerCbQuery();
    return;
  }

  let statusMsg = '⚠️ *API/Bot Status*\n\n';
  try {
    await axios.get(PAYCREST_RATE_API_URL, { headers: { Authorization: `Bearer ${PAYCREST_API_KEY}` } });
    statusMsg += '✅ Paycrest API: Online\n';
  } catch (error) {
    statusMsg += '❌ Paycrest API: Offline\n';
  }

  try {
    await axios.get('https://api.blockradar.co/v1/status', { headers: { 'x-api-key': BLOCKRADAR_BASE_API_KEY } });
    statusMsg += '✅ Blockradar API: Online\n';
  } catch (error) {
    statusMsg += '❌ Blockradar API: Offline\n';
  }

  statusMsg += `✅ Bot: Running (Uptime: ${Math.floor(process.uptime() / 3600)}h)\n`;
  statusMsg += `📊 Exchange Rates: USDC ₦${exchangeRates.USDC}, USDT ₦${exchangeRates.USDT}`;

  await ctx.editMessageText(statusMsg, {
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'admin_back_to_main')]]).reply_markup
  });
  ctx.answerCbQuery();
});

bot.action('admin_back_to_main', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    await ctx.replyWithMarkdown('❌ You no be admin.');
    ctx.answerCbQuery();
    return;
  }

  await ctx.editMessageText('🔧 *Admin Panel*\n\nPick an option:', {
    parse_mode: 'Markdown',
    reply_markup: getAdminMenu().reply_markup
  });
  ctx.answerCbQuery();
});
// all bot.on (text) in on place
bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const text = ctx.message.text.trim();

  // Refund Address Handling
  if (ctx.session.awaitingRefundAddress) {
    let refundAddress = text.toLowerCase() === 'default' ? null : text;
    if (text.toLowerCase() === 'default') {
      if (userState.wallets.length === 0) {
        const errorMsg = userState.usePidgin
          ? '❌ You no get wallet yet. Generate one first.'
          : '❌ You don’t have any wallets yet. Generate one first.';
        await ctx.replyWithMarkdown(errorMsg);
        delete ctx.session.awaitingRefundAddress;
        return;
      } else if (userState.wallets.length > 1) {
        const walletButtons = userState.wallets.map((wallet, index) => [
          Markup.button.callback(`Wallet ${index + 1} - ${wallet.chain} (${wallet.address.slice(0, 6)}...)`, `select_default_wallet_${index}`)
        ]);
        const prompt = userState.usePidgin
          ? '🏦 *Pick Default Wallet*\n\nYou get multiple wallets. Which one you want as default for refund?'
          : '🏦 *Select Default Wallet*\n\nYou have multiple wallets. Which one should be the default for refunds?';
        await ctx.replyWithMarkdown(prompt, Markup.inlineKeyboard(walletButtons));
        ctx.session.awaitingDefaultWalletSelection = true;
        delete ctx.session.awaitingRefundAddress;
        return;
      } else {
        refundAddress = userState.wallets[0].address;
      }
    }

    if (refundAddress && !ethers.utils.isAddress(refundAddress)) {
      const errorMsg = userState.usePidgin
        ? '❌ Address no correct. Enter valid Ethereum address or "default".'
        : '❌ Invalid address. Please enter a valid Ethereum address or "default".';
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }

    await updateUserState(userId, { refundAddress });
    const successMsg = userState.usePidgin
      ? refundAddress
        ? `✅ Refund address set to \`${refundAddress}\`.`
        : '✅ Refund address reset to default (your wallet).'
      : refundAddress
        ? `✅ Refund address set to \`${refundAddress}\`.`
        : '✅ Refund address reset to default (your wallet).';
    await ctx.replyWithMarkdown(successMsg);
    delete ctx.session.awaitingRefundAddress;
    return;
  }

  // Default Wallet Selection (this shouldn't be here, it's handled by bot.action)
  if (ctx.session.awaitingDefaultWalletSelection) {
    // This block is redundant since it's handled by bot.action(/select_default_wallet_(\d+)/)
    // Remove it from here to avoid confusion
    return;
  }

  // Wallet Renaming
  if (ctx.session.awaitingWalletName) {
    const walletIndex = ctx.session.walletIndex;
    if (walletIndex === undefined || walletIndex >= userState.wallets.length) {
      const errorMsg = userState.usePidgin
        ? '❌ Wallet no dey. Start again.'
        : '❌ Invalid wallet. Please start over.';
      await ctx.replyWithMarkdown(errorMsg);
      delete ctx.session.awaitingWalletName;
      delete ctx.session.walletIndex;
      return;
    }

    userState.wallets[walletIndex].name = text.slice(0, 20);
    await updateUserState(userId, { wallets: userState.wallets });
    const successMsg = userState.usePidgin
      ? `✅ Wallet ${walletIndex + 1} don rename to "${text.slice(0, 20)}".`
      : `✅ Wallet ${walletIndex + 1} renamed to "${text.slice(0, 20)}".`;
    await ctx.replyWithMarkdown(successMsg);
    delete ctx.session.awaitingWalletName;
    delete ctx.session.walletIndex;
    return;
  }

  // Language Switching
  if (text.toLowerCase() === 'pidgin') {
    await updateUserState(userId, { usePidgin: true });
    await ctx.replyWithMarkdown('✅ Switched to Pidgin! Enjoy the vibe.');
    await greetUser(ctx);
    return;
  }

  if (text.toLowerCase() === 'english') {
    await updateUserState(userId, { usePidgin: false });
    await ctx.replyWithMarkdown('✅ Switched to English! Enjoy your experience.');
    await greetUser(ctx);
    return;
  }

  // Admin Commands (Manual Payout and Refund)
  if (isAdmin(userId)) {
    if (ctx.session.awaitingManualPayout) {
      const [targetUserId, amountStr, asset, referenceId] = text.split(' ');
      const amount = parseFloat(amountStr);

      if (!targetUserId || isNaN(amount) || !asset || !referenceId || !SUPPORTED_ASSETS.includes(asset.toUpperCase())) {
        await ctx.replyWithMarkdown('❌ Format no correct. Use: `<User ID> <Amount> <Asset> <Reference ID>`\nE.g., `123456789 100 USDT REF-ABC123`');
        return;
      }

      try {
        const userState = await getUserState(targetUserId);
        if (!userState.wallets.length) {
          await ctx.replyWithMarkdown(`❌ User ${targetUserId} no get wallet.`);
          delete ctx.session.awaitingManualPayout;
          return;
        }

        const wallet = userState.wallets[0];
        if (!wallet.bank) {
          await ctx.replyWithMarkdown(`❌ User ${targetUserId} no link bank.`);
          delete ctx.session.awaitingManualPayout;
          return;
        }

        const payout = calculatePayout(asset.toUpperCase(), amount);
        const order = await createPaycrestOrder(targetUserId, payout, asset.toUpperCase(), wallet.chain, wallet.bank, wallet.address);

        await db.collection('transactions').doc(referenceId).set({
          userId: targetUserId,
          walletAddress: wallet.address,
          amount,
          asset: asset.toUpperCase(),
          payout,
          status: 'Pending',
          referenceId,
          chain: wallet.chain,
          timestamp: new Date().toISOString(),
          bankDetails: wallet.bank,
          paycrestOrderId: order.orderId
        });

        await bot.telegram.sendMessage(targetUserId, `✅ *Manual Payout Initiated*\n\n*Amount:* ${amount} ${asset}\n*Payout:* ₦${payout}\n*Ref ID:* \`${referenceId}\`\n\nFunds dey process to your bank.`, { parse_mode: 'Markdown' });
        await ctx.replyWithMarkdown(`✅ Payout of ${amount} ${asset} (₦${payout}) initiated for user ${targetUserId}. Ref: \`${referenceId}\``);
        logger.info(`Manual payout initiated by ${userId} for ${targetUserId}: ${amount} ${asset}, Ref: ${referenceId}`);
      } catch (error) {
        logger.error(`Error processing manual payout by ${userId}: ${error.message}`);
        await ctx.replyWithMarkdown('❌ Error starting payout. Check details and try again.');
      }
      delete ctx.session.awaitingManualPayout;
      return;
    }

    if (ctx.session.awaitingRefundTx) {
      const referenceId = text;
      try {
        const txDoc = await db.collection('transactions').doc(referenceId).get();
        if (!txDoc.exists) {
          await ctx.replyWithMarkdown(`❌ No transaction with Ref ID \`${referenceId}\`.`);
          delete ctx.session.awaitingRefundTx;
          return;
        }

        const tx = txDoc.data();
        if (tx.status === 'Refunded') {
          await ctx.replyWithMarkdown(`❌ Transaction \`${referenceId}\` don already refund.`);
          delete ctx.session.awaitingRefundTx;
          return;
        }

        const userState = await getUserState(tx.userId);
        const refundAddress = userState.refundAddress || tx.walletAddress;
        const chainData = chains[tx.chain];
        const assetId = chainData.assets[tx.asset];

        const refundResponse = await withdrawFromBlockradar(tx.chain, assetId, refundAddress, tx.amount, referenceId, { reason: 'Admin-initiated refund' });
        await db.collection('transactions').doc(referenceId).update({
          status: 'Refunded',
          refundAddress,
          refundTimestamp: new Date().toISOString(),
          refundTxHash: refundResponse.transactionHash
        });

        await bot.telegram.sendMessage(tx.userId, `🔄 *Transaction Refunded*\n\n*Ref ID:* \`${referenceId}\`\n*Amount:* ${tx.amount} ${tx.asset}\n*Sent To:* \`${refundAddress}\`\n\nCheck your wallet!`, { parse_mode: 'Markdown' });
        await ctx.replyWithMarkdown(`✅ Refunded ${tx.amount} ${tx.asset} to \`${refundAddress}\` for Ref ID \`${referenceId}\`.`);
        logger.info(`Admin ${userId} refunded transaction ${referenceId}: ${tx.amount} ${tx.asset} to ${refundAddress}`);
      } catch (error) {
        logger.error(`Error refunding transaction ${referenceId} by ${userId}: ${error.message}`);
        await ctx.replyWithMarkdown('❌ Error refunding transaction. Try again.');
      }
      delete ctx.session.awaitingRefundTx;
      return;
    }
  }
});
