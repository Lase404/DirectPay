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
require('dotenv').config();

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

// =================== Chain Mapping ===================
const chainMapping = {
  'base': 'Base',
  'polygon': 'Polygon',
  'bnb smart chain': 'BNB Smart Chain',
  'bnb smartchain': 'BNB Smart Chain',
  'bnb chain': 'BNB Smart Chain',
  'bnb': 'BNB Smart Chain',
  'solana': 'Solana'
};

// =================== Solana Token Configurations ===================
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

// =================== Relay.link Constants ===================
const RELAY_API_URL = 'https://api.relay.link/quote';
const PAYCREST_RECEIVE_ADDRESS = '0xF0AE622e463fa757Cf72243569E18Be7Df1996cd';
const BASE_USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const SOLANA_CHAIN_ID = 792703809;
const BASE_CHAIN_ID = 8453;
const MASTER_WALLET_ADDRESS = '5suX7i7exg7k6iuq4G2poDN1zLySiHWf6QyHwbkSx7hm';

// =================== Constants ===================
const SUPPORTED_ASSETS = ['USDC', 'USDT'];
let exchangeRates = { USDC: 1500, USDT: 1495 };

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
  const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(address)}`;
  const qrResponse = await axios.get(qrCodeUrl, { responseType: 'arraybuffer' });
  const qrCodeBuffer = Buffer.from(qrResponse.data);
  await sharp(baseImagePath)
    .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
    .composite([{ input: qrCodeBuffer, top: 250, left: 210 }])
    .png()
    .toFile(outputPath);
}

async function cleanupOldQrCodes(userId, newQrPaths) {
  try {
    const userState = await getUserState(userId);
    for (const wallet of userState.wallets) {
      if (wallet.evmQrPath && !newQrPaths.includes(wallet.evmQrPath)) {
        try {
          await unlinkAsync(wallet.evmQrPath);
        } catch (err) {
          logger.warn(`Failed to delete old EVM QR code ${wallet.evmQrPath}: ${err.message}`);
        }
      }
      if (wallet.solanaQrPath && !newQrPaths.includes(wallet.solanaQrPath)) {
        try {
          await unlinkAsync(wallet.solanaQrPath);
        } catch (err) {
          logger.warn(`Failed to delete old Solana QR code ${wallet.solanaQrPath}: ${err.message}`);
        }
      }
    }
  } catch (error) {
    logger.error(`Error cleaning up QR codes for user ${userId}: ${error.message}`);
  }
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
    await ctx.replyWithMarkdown(prompt, Markup.inlineKeyboard([
      [Markup.button.callback('🔙 Back', 'cancel_bank_linking')],
      [Markup.button.callback('⏭ Link Later', `link_later_${userState.wallets[walletIndex].address}`)]
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
        [Markup.button.callback('🔙 Back', 'cancel_bank_linking')],
        [Markup.button.callback('⏭ Link Later', `link_later_${userState.wallets[ctx.session.walletIndex].address}`)]
      ]));
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
        [Markup.button.callback('🔙 Back', 'cancel_bank_linking')],
        [Markup.button.callback('⏭ Link Later', `link_later_${userState.wallets[ctx.session.walletIndex].address}`)]
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
    await ctx.replyWithMarkdown(prompt, Markup.inlineKeyboard([
      [Markup.button.callback('🔙 Back', 'cancel_bank_linking')],
      [Markup.button.callback('⏭ Link Later', `link_later_${userState.wallets[ctx.session.walletIndex].address}`)]
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
        [Markup.button.callback('🔙 Back', 'cancel_bank_linking')],
        [Markup.button.callback('⏭ Link Later', `link_later_${userState.wallets[ctx.session.walletIndex].address}`)]
      ]));
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
        [Markup.button.callback('🔙 Back', 'cancel_bank_linking')],
        [Markup.button.callback('⏭ Link Later', `link_later_${userState.wallets[ctx.session.walletIndex].address}`)]
      ]));
      return ctx.wizard.next();
    } catch (error) {
      logger.error(`Error verifying bank account for user ${userId}: ${error.message}`);
      const errorMsg = userState.usePidgin
        ? '❌ E no work. Check your details or try again.'
        : '❌ Failed to verify your bank account. Check your details or try again.';
      await ctx.replyWithMarkdown(errorMsg, Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Back', 'cancel_bank_linking')],
        [Markup.button.callback('⏭ Link Later', `link_later_${userState.wallets[ctx.session.walletIndex].address}`)]
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
  const suggestedBank = ctx.session.bankData.suggestedBank;

  ctx.session.bankData.bankName = suggestedBank.name;
  ctx.session.bankData.bankCode = suggestedBank.code;
  ctx.session.bankData.step = 2;

  const prompt = userState.usePidgin
    ? '🔢 Enter your 10-digit account number:'
    : '🔢 Please enter your 10-digit bank account number:';
  await ctx.replyWithMarkdown(prompt, Markup.inlineKeyboard([
    [Markup.button.callback('🔙 Back', 'cancel_bank_linking')],
    [Markup.button.callback('⏭ Link Later', `link_later_${userState.wallets[ctx.session.walletIndex].address}`)]
  ]));
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
  await ctx.replyWithMarkdown(prompt, Markup.inlineKeyboard([
    [Markup.button.callback('🔙 Back', 'cancel_bank_linking')],
    [Markup.button.callback('⏭ Link Later', `link_later_${userState.wallets[ctx.session.walletIndex].address}`)]
  ]));
  await ctx.answerCbQuery();
});

bankLinkingScene.action('confirm_bank_yes', async (ctx) => {
  const userId = ctx.from.id.toString();
  const bankData = ctx.session.bankData;
  const walletIndex = ctx.session.walletIndex;
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
        `📂 *Wallet Details:*\n` +
        `• *EVM Chain:* Base\n` +
        `• *EVM Address:* \`${walletAddress}\`\n` +
        `• *Solana Address:* \`${solanaAddress}\`\n\n` +
        `You fit start receive payouts now.\n\n*Refund Address:* Set one in "⚙️ Settings" if payout fail (default na this wallet).`
      : `✅ *Bank Account Linked*\n\n` +
        `*Bank Name:* ${bankData.bankName}\n` +
        `*Account Number:* \`${bankData.accountNumber}\`\n` +
        `*Account Holder:* ${bankData.accountName}\n\n` +
        `📂 *Wallet Details:*\n` +
        `• *EVM Chain:* Base\n` +
        `• *EVM Address:* \`${walletAddress}\`\n` +
        `• *Solana Address:* \`${solanaAddress}\`\n\n` +
        `You can now receive payouts.\n\n*Refund Address:* Set one in "⚙️ Settings" for failed payouts (defaults to this wallet).`;

    await ctx.replyWithPhoto({ source: createReadStream(evmQrPath) }, {
      caption: confirmationMessage,
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Show Solana Wallet', `show_solana_wallet_${walletIndex}`)],
        [Markup.button.callback('🏠 Main Menu', 'back_to_main')]
      ])
    });

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
    [Markup.button.callback('🔙 Back', 'cancel_bank_linking')],
    [Markup.button.callback('⏭ Link Later', `link_later_${userState.wallets[ctx.session.walletIndex].address}`)]
  ]));
  ctx.session.bankData = {};
  ctx.session.bankData.step = 1;
  await ctx.answerCbQuery();
  ctx.wizard.selectStep(1);
});

bankLinkingScene.action(/link_later_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const address = ctx.match[1];
  const userState = await getUserState(userId);
  const walletIndex = userState.wallets.findIndex(w => w.address === address);

  if (walletIndex === -1) {
    const errorMsg = userState.usePidgin
      ? '❌ Wallet no dey. Start again.'
      : '❌ Invalid wallet. Please start over.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  const evmQrPath = path.join(__dirname, `temp_evm_qr_${userId}_${Date.now()}.png`);
  const solanaQrPath = path.join(__dirname, `temp_solana_qr_${userId}_${Date.now()}.png`);

  try {
    userState.wallets[walletIndex].evmQrPath = evmQrPath;
    userState.wallets[walletIndex].solanaQrPath = solanaQrPath;

    await generateQRCodeImage(userState.wallets[walletIndex].address, WALLET_GENERATED_IMAGE, evmQrPath);
    await generateQRCodeImage(userState.wallets[walletIndex].solanaAddress, WALLET_GENERATED_IMAGE, solanaQrPath);

    await updateUserState(userId, { wallets: userState.wallets });
    await cleanupOldQrCodes(userId, [evmQrPath, solanaQrPath]);

    const walletAddress = userState.wallets[walletIndex].address;
    const solanaAddress = userState.wallets[walletIndex].solanaAddress;

    const message = userState.usePidgin
      ? `📂 *Wallet Details:*\n\n` +
        `• *EVM Chain:* Base\n` +
        `• *EVM Address:* \`${walletAddress}\`\n` +
        `• *Solana Address:* \`${solanaAddress}\`\n\n` +
        `Link your bank in "⚙️ Settings" to start receiving payouts.\n\n*Refund Address:* Set one in "⚙️ Settings" if payout fail (default na this wallet).`
      : `📂 *Wallet Details:*\n\n` +
        `• *EVM Chain:* Base\n` +
        `• *EVM Address:* \`${walletAddress}\`\n` +
        `• *Solana Address:* \`${solanaAddress}\`\n\n` +
        `Link your bank in "⚙️ Settings" to start receiving payouts.\n\n*Refund Address:* Set one in "⚙️ Settings" for failed payouts (defaults to this wallet).`;

    await ctx.replyWithPhoto({ source: createReadStream(evmQrPath) }, {
      caption: message,
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Show Solana Wallet', `show_solana_wallet_${walletIndex}`)],
        [Markup.button.callback('⚙️ Settings', 'settings_back')]
      ])
    });

    await ctx.answerCbQuery();
    ctx.scene.leave();
  } catch (error) {
    logger.error(`Error in link_later for user ${userId}: ${error.message}`);
    const errorMsg = userState.usePidgin
      ? '❌ Problem showing wallet. Try again later or contact [@maxcswap](https://t.me/maxcswap).'
      : '❌ Error showing wallet details. Try again later or contact [@maxcswap](https://t.me/maxcswap).';
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
    ctx.scene.leave();
  }
});

bankLinkingScene.action('cancel_bank_linking', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const walletIndex = ctx.session.walletIndex;
  const wallet = userState.wallets[walletIndex];
  const errorMsg = userState.usePidgin
    ? `❌ You cancel bank linking.\n\nClick "Link Later" to see your wallets now. You fit link bank anytime in "⚙️ Settings".`
    : `❌ Bank linking cancelled.\n\nClick "Link Later" to view your wallet details now. You can link a bank anytime in "⚙️ Settings".`;
  await ctx.replyWithMarkdown(errorMsg, Markup.inlineKeyboard([
    [Markup.button.callback('🔗 Link Later', `link_later_${wallet ? wallet.address : ''}`)],
    [Markup.button.callback('⚙️ Settings', 'settings_back')]
  ]));
  delete ctx.session.walletIndex;
  delete ctx.session.bankData;
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
  const solanaQrPath = wallet.solanaQrPath;

  if (!fs.existsSync(solanaQrPath)) {
    const newSolanaQrPath = path.join(__dirname, `temp_solana_qr_${userId}_${Date.now()}.png`);
    await generateQRCodeImage(wallet.solanaAddress, WALLET_GENERATED_IMAGE, newSolanaQrPath);
    wallet.solanaQrPath = newSolanaQrPath;
    await updateUserState(userId, { wallets: userState.wallets });
    await cleanupOldQrCodes(userId, [wallet.evmQrPath, newSolanaQrPath]);
  }

  const message = userState.usePidgin
    ? `📂 *Wallet Details*\n\n` +
      `• *EVM Chain:* Base\n` +
      `• *EVM Address:* \`${wallet.address}\`\n` +
      `• *Solana Address:* \`${wallet.solanaAddress}\`\n\n` +
      `You fit receive payouts now.\n\n*Refund Address:* Set one in "⚙️ Settings" if payout fail (default na this wallet).`
    : `📂 *Wallet Details*\n\n` +
      `• *EVM Chain:* Base\n` +
      `• *EVM Address:* \`${wallet.address}\`\n` +
      `• *Solana Address:* \`${wallet.solanaAddress}\`\n\n` +
      `You can now receive payouts.\n\n*Refund Address:* Set one in "⚙️ Settings" for failed payouts (defaults to this wallet).`;

  await ctx.editMessageMedia(
    { type: 'photo', media: { source: createReadStream(wallet.solanaQrPath) } },
    {
      caption: message,
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Show EVM Wallet', `show_evm_wallet_${walletIndex}`)],
        [Markup.button.callback('🏠 Main Menu', 'back_to_main')]
      ])
    }
  );

  await ctx.answerCbQuery();
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
  const evmQrPath = wallet.evmQrPath;

  if (!fs.existsSync(evmQrPath)) {
    const newEvmQrPath = path.join(__dirname, `temp_evm_qr_${userId}_${Date.now()}.png`);
    await generateQRCodeImage(wallet.address, WALLET_GENERATED_IMAGE, newEvmQrPath);
    wallet.evmQrPath = newEvmQrPath;
    await updateUserState(userId, { wallets: userState.wallets });
    await cleanupOldQrCodes(userId, [newEvmQrPath, wallet.solanaQrPath]);
  }

  const message = userState.usePidgin
    ? `📂 *Wallet Details*\n\n` +
      `• *EVM Chain:* Base\n` +
      `• *EVM Address:* \`${wallet.address}\`\n` +
      `• *Solana Address:* \`${wallet.solanaAddress}\`\n\n` +
      `You fit receive payouts now.\n\n*Refund Address:* Set one in "⚙️ Settings" if payout fail (default na this wallet).`
    : `📂 *Wallet Details*\n\n` +
      `• *EVM Chain:* Base\n` +
      `• *EVM Address:* \`${wallet.address}\`\n` +
      `• *Solana Address:* \`${wallet.solanaAddress}\`\n\n` +
      `You can now receive payouts.\n\n*Refund Address:* Set one in "⚙️ Settings" for failed payouts (defaults to this wallet).`;

  await ctx.editMessageMedia(
    { type: 'photo', media: { source: createReadStream(wallet.evmQrPath) } },
    {
      caption: message,
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Show Solana Wallet', `show_solana_wallet_${walletIndex}`)],
        [Markup.button.callback('🏠 Main Menu', 'back_to_main')]
      ])
    }
  );

  await ctx.answerCbQuery();
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
        .where('walletAddress', 'in', [wallet.address, wallet.solanaAddress])
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
    res.status(500).json({ status: 'error', message: error.message });
  }
});
// =================== Main Menu ===================
const getMainMenu = (walletExists, hasBankLinked) =>
  Markup.keyboard([
    [walletExists ? "💼 View Wallet" : "💼 Generate Wallet", "⚙️ Settings"],
    ["💰 Transactions", "🌉 Bridge & Cash Out", "ℹ️ Support"],
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

// =================== Fetch Exchange Rates ===================
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

  if (ctx.scene.current && ctx.scene.current.id === 'bank_linking_scene') {
    const userState = await getUserState(userId);
    const msg = userState.usePidgin
      ? '⚠️ You dey link bank now. Finish am first.'
      : '⚠️ You’re currently linking a bank. Finish that first.';
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
    const solanaChain = 'Solana';
    const generatingMessage = await ctx.replyWithMarkdown(userState.usePidgin
      ? `🔄 Generating wallets for ${chain} and Solana. Wait small...`
      : `🔄 Generating your wallets on ${chain} and Solana. Please wait...`);

    try {
      const [walletAddress, solanaAddress] = await Promise.all([
        generateWallet(chain),
        generateWallet(solanaChain)
      ]);

      userState.wallets.push({
        address: walletAddress,
        solanaAddress: solanaAddress,
        chain: chain,
        supportedAssets: chains[chain].supportedAssets,
        bank: null,
        amount: 0,
        creationDate: new Date().toISOString(),
        totalDeposits: 0,
        totalPayouts: 0
      });
      userState.walletAddresses.push(walletAddress, solanaAddress);

      await updateUserState(userId, {
        wallets: userState.wallets,
        walletAddresses: userState.walletAddresses
      });

      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `💼 Wallet generated for user ${userId} on ${chain} (EVM: ${walletAddress}, Solana: ${solanaAddress})`, { parse_mode: 'Markdown' });
      logger.info(`Wallet generated for user ${userId} on ${chain}: EVM ${walletAddress}, Solana ${solanaAddress}`);

      const newWalletIndex = userState.wallets.length - 1;
      ctx.session.walletIndex = newWalletIndex;

      await ctx.deleteMessage(generatingMessage.message_id);

      const successMsg = userState.usePidgin
        ? `✅ *Wallet Ready*\n\n` +
          `*Networks:* Base, BNB Smart Chain, Polygon (EVM), Solana\n` +
          `*Assets:* USDC, USDT\n\n` +
          `Let’s link your bank now to start using it.\n\n*Refund Address:* Set one in "⚙️ Settings" if payout fail (default na this wallet).`
        : `✅ *Wallet Generated*\n\n` +
          `*Networks:* Base, BNB Smart Chain, Polygon (EVM), Solana\n` +
          `*Assets:* USDC, USDT\n\n` +
          `Let’s link your bank now to start using it.\n\n*Refund Address:* Set one in "⚙️ Settings" for failed payouts (defaults to this wallet).`;
      await ctx.replyWithMarkdown(successMsg);

      if (suggestPidgin && !userState.usePidgin) {
        await ctx.replyWithMarkdown('👋 You dey Nigeria? Type "Pidgin" to switch if you like.');
      }

      await ctx.scene.enter('bank_linking_scene');
    } catch (error) {
      logger.error(`Error generating wallet for user ${userId}: ${error.message}`);
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
            `• *EVM Address:* \`${wallet.address}\`\n`+
            `• *Solana Address:* \`${wallet.solanaAddress}\`\n` +
            `• *Chain:* ${wallet.chain}\n` +
            `• *Assets:* ${wallet.supportedAssets.join(', ')}\n` +
            `• *Bank Linked:* ${wallet.bank ? `${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)})` : 'Not Linked'}\n` +
            `• *Created:* ${new Date(wallet.creationDate).toLocaleDateString()}\n` +
            `• *Total Deposits:* ${wallet.totalDeposits || 0} USD\n` +
            `• *Total Payouts:* ${wallet.totalPayouts || 0} NGN\n\n`
          : `*Wallet ${walletNumber} (${wallet.name || 'Unnamed'}):*\n` +
            `• *EVM Address:* \`${wallet.address}\`\n` +
            `• *Solana Address:* \`${wallet.solanaAddress}\`\n` +
            `• *Chain:* ${wallet.chain}\n` +
            `• *Assets:* ${wallet.supportedAssets.join(', ')}\n` +
            `• *Bank Linked:* ${wallet.bank ? `${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)})` : 'Not Linked'}\n` +
            `• *Created:* ${new Date(wallet.creationDate).toLocaleDateString()}\n` +
            `• *Total Deposits:* ${wallet.totalDeposits || 0} USD\n` +
            `• *Total Payouts:* ${wallet.totalPayouts || 0} NGN\n\n`;
      });

      const keyboard = [];
      wallets.forEach((_, index) => {
        const walletNumber = start + index + 1;
        keyboard.push([
          Markup.button.callback(`View Wallet ${walletNumber}`, `view_wallet_${start + index}`)
        ]);
      });

      const navButtons = [];
      if (page > 1) {
        navButtons.push(Markup.button.callback('⬅️ Previous', `wallets_page_${page - 1}`));
      }
      if (page < totalPages) {
        navButtons.push(Markup.button.callback('➡️ Next', `wallets_page_${page + 1}`));
      }
      if (navButtons.length > 0) {
        keyboard.push(navButtons);
      }
      keyboard.push([Markup.button.callback('🏠 Main Menu', 'back_to_main')]);

      return { message, keyboard };
    };

    const { message, keyboard } = await generateWalletPage(ctx.session.walletsPage);
    await ctx.replyWithMarkdown(message, Markup.inlineKeyboard(keyboard));
  } catch (error) {
    logger.error(`Error in View Wallet for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Something went wrong. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
  }
});

// =================== Wallet Page Navigation ===================
bot.action(/wallets_page_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const page = parseInt(ctx.match[1], 10);

  try {
    const userState = await getUserState(userId);
    if (userState.wallets.length === 0) {
      const errorMsg = userState.usePidgin
        ? '❌ No wallet dey. Click "💼 Generate Wallet" to start.'
        : '❌ You have no wallets. Generate one with "💼 Generate Wallet".';
      await ctx.replyWithMarkdown(errorMsg);
      await ctx.answerCbQuery();
      return;
    }

    const pageSize = 3;
    const totalPages = Math.max(1, Math.ceil(userState.wallets.length / pageSize));
    if (page < 1 || page > totalPages) {
      await ctx.answerCbQuery('Invalid page.');
      return;
    }

    ctx.session.walletsPage = page;

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
            `• *EVM Address:* \`${wallet.address}\`\n` +
            `• *Solana Address:* \`${wallet.solanaAddress}\`\n` +
            `• *Chain:* ${wallet.chain}\n` +
            `• *Assets:* ${wallet.supportedAssets.join(', ')}\n` +
            `• *Bank Linked:* ${wallet.bank ? `${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)})` : 'Not Linked'}\n` +
            `• *Created:* ${new Date(wallet.creationDate).toLocaleDateString()}\n` +
            `• *Total Deposits:* ${wallet.totalDeposits || 0} USD\n` +
            `• *Total Payouts:* ${wallet.totalPayouts || 0} NGN\n\n`
          : `*Wallet ${walletNumber} (${wallet.name || 'Unnamed'}):*\n` +
            `• *EVM Address:* \`${wallet.address}\`\n` +
            `• *Solana Address:* \`${wallet.solanaAddress}\`\n` +
            `• *Chain:* ${wallet.chain}\n` +
            `• *Assets:* ${wallet.supportedAssets.join(', ')}\n` +
            `• *Bank Linked:* ${wallet.bank ? `${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)})` : 'Not Linked'}\n` +
            `• *Created:* ${new Date(wallet.creationDate).toLocaleDateString()}\n` +
            `• *Total Deposits:* ${wallet.totalDeposits || 0} USD\n` +
            `• *Total Payouts:* ${wallet.totalPayouts || 0} NGN\n\n`;
      });

      const keyboard = [];
      wallets.forEach((_, index) => {
        const walletNumber = start + index + 1;
        keyboard.push([
          Markup.button.callback(`View Wallet ${walletNumber}`, `view_wallet_${start + index}`)
        ]);
      });

      const navButtons = [];
      if (page > 1) {
        navButtons.push(Markup.button.callback('⬅️ Previous', `wallets_page_${page - 1}`));
      }
      if (page < totalPages) {
        navButtons.push(Markup.button.callback('➡️ Next', `wallets_page_${page + 1}`));
      }
      if (navButtons.length > 0) {
        keyboard.push(navButtons);
      }
      keyboard.push([Markup.button.callback('🏠 Main Menu', 'back_to_main')]);

      return { message, keyboard };
    };

    const { message, keyboard } = await generateWalletPage(page);
    await ctx.editMessageText(message, {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard(keyboard)
    });
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error navigating wallet page for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Something went wrong. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
  }
});

// =================== View Specific Wallet ===================
bot.action(/view_wallet_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);

  try {
    const userState = await getUserState(userId);
    if (!userState.wallets[walletIndex]) {
      const errorMsg = userState.usePidgin
        ? '❌ Wallet no dey. Start again.'
        : '❌ Invalid wallet. Please start over.';
      await ctx.replyWithMarkdown(errorMsg);
      await ctx.answerCbQuery();
      return;
    }

    const wallet = userState.wallets[walletIndex];
    const evmQrPath = wallet.evmQrPath || path.join(__dirname, `temp_evm_qr_${userId}_${Date.now()}.png`);
    const solanaQrPath = wallet.solanaQrPath || path.join(__dirname, `temp_solana_qr_${userId}_${Date.now()}.png`);

    if (!wallet.evmQrPath || !fs.existsSync(wallet.evmQrPath)) {
      await generateQRCodeImage(wallet.address, WALLET_GENERATED_IMAGE, evmQrPath);
      wallet.evmQrPath = evmQrPath;
    }
    if (!wallet.solanaQrPath || !fs.existsSync(wallet.solanaQrPath)) {
      await generateQRCodeImage(wallet.solanaAddress, WALLET_GENERATED_IMAGE, solanaQrPath);
      wallet.solanaQrPath = solanaQrPath;
    }

    await updateUserState(userId, { wallets: userState.wallets });
    await cleanupOldQrCodes(userId, [evmQrPath, solanaQrPath]);

    const message = userState.usePidgin
      ? `📂 *Wallet ${walletIndex + 1} (${wallet.name || 'Unnamed'})*\n\n` +
        `• *EVM Chain:* ${wallet.chain}\n` +
        `• *EVM Address:* \`${wallet.address}\`\n` +
        `• *Solana Address:* \`${wallet.solanaAddress}\`\n` +
        `• *Assets:* ${wallet.supportedAssets.join(', ')}\n` +
        `• *Bank Linked:* ${wallet.bank ? `${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)})` : 'Not Linked'}\n` +
        `• *Created:* ${new Date(wallet.creationDate).toLocaleDateString()}\n` +
        `• *Total Deposits:* ${wallet.totalDeposits || 0} USD\n` +
        `• *Total Payouts:* ${wallet.totalPayouts || 0} NGN\n\n` +
        `Send USDC or USDT to any address above.\n\n*Refund Address:* Set one in "⚙️ Settings" if payout fail (default na this wallet).`
      : `📂 *Wallet ${walletIndex + 1} (${wallet.name || 'Unnamed'})*\n\n` +
        `• *EVM Chain:* ${wallet.chain}\n` +
        `• *EVM Address:* \`${wallet.address}\`\n` +
        `• *Solana Address:* \`${wallet.solanaAddress}\`\n` +
        `• *Assets:* ${wallet.supportedAssets.join(', ')}\n` +
        `• *Bank Linked:* ${wallet.bank ? `${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)})` : 'Not Linked'}\n` +
        `• *Created:* ${new Date(wallet.creationDate).toLocaleDateString()}\n` +
        `• *Total Deposits:* ${wallet.totalDeposits || 0} USD\n` +
        `• *Total Payouts:* ${wallet.totalPayouts || 0} NGN\n\n` +
        `Send USDC or USDT to any address above.\n\n*Refund Address:* Set one in "⚙️ Settings" for failed payouts (defaults to this wallet).`;

    await ctx.replyWithPhoto({ source: createReadStream(evmQrPath) }, {
      caption: message,
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Show Solana Wallet', `show_solana_wallet_${walletIndex}`)],
        [Markup.button.callback('🏦 Link Bank', `link_bank_${walletIndex}`)],
        [Markup.button.callback('🏠 Main Menu', 'back_to_main')]
      ])
    });

    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error viewing wallet for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Something went wrong. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
  }
});

// =================== Link Bank Action ===================
bot.action(/link_bank_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);

  try {
    const userState = await getUserState(userId);
    if (!userState.wallets[walletIndex]) {
      const errorMsg = userState.usePidgin
        ? '❌ Wallet no dey. Start again.'
        : '❌ Invalid wallet. Please start over.';
      await ctx.replyWithMarkdown(errorMsg);
      await ctx.answerCbQuery();
      return;
    }

    ctx.session.walletIndex = walletIndex;
    await ctx.scene.enter('bank_linking_scene');
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error initiating bank linking for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Something went wrong. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
  }
});

// =================== Transactions Handler ===================
bot.hears('💰 Transactions', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    const userState = await getUserState(userId);
    if (userState.wallets.length === 0) {
      const errorMsg = userState.usePidgin
        ? '❌ No wallet dey. Click "💼 Generate Wallet" to start.'
        : '❌ You have no wallets. Generate one with "💼 Generate Wallet".';
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }

    await ctx.scene.enter('receipt_generation_scene');
  } catch (error) {
    logger.error(`Error in Transactions handler for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Something went wrong. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
  }
});

// =================== Export Receipt Action ===================
bot.action(/export_receipt_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);

  try {
    const userState = await getUserState(userId);
    const wallet = userState.wallets[walletIndex];
    if (!wallet) {
      const errorMsg = userState.usePidgin
        ? '❌ Wallet no dey. Start again.'
        : '❌ Invalid wallet. Please start over.';
      await ctx.replyWithMarkdown(errorMsg);
      await ctx.answerCbQuery();
      return;
    }

    const transactionsSnapshot = await db.collection('transactions')
      .where('walletAddress', 'in', [wallet.address, wallet.solanaAddress])
      .orderBy('timestamp', 'desc')
      .limit(10)
      .get();

    if (transactionsSnapshot.empty) {
      const noTxMsg = userState.usePidgin
        ? 'No transactions for this wallet yet.'
        : 'No transactions found for this wallet yet.';
      await ctx.replyWithMarkdown(noTxMsg);
      await ctx.answerCbQuery();
      return;
    }

    let receiptText = userState.usePidgin
      ? `🧾 Receipt for Wallet ${walletIndex + 1} - ${wallet.chain}\n\n`
      : `🧾 Transaction Receipt for Wallet ${walletIndex + 1} - ${wallet.chain}\n\n`;
    transactionsSnapshot.forEach((doc) => {
      const tx = doc.data();
      receiptText += `Transaction ${tx.referenceId || 'N/A'}:\n`;
      receiptText += `Ref ID: ${tx.referenceId || 'N/A'}\n`;
      receiptText += `Amount: ${tx.amount || 'N/A'} ${tx.asset || 'N/A'}\n`;
      receiptText += `Status: ${tx.status || 'Pending'}\n`;
      receiptText += `Rate: ₦${exchangeRates[tx.asset] || 'N/A'} per ${tx.asset || 'N/A'}\n`;
      receiptText += `Date: ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n`;
      receiptText += `Chain: ${tx.chain || 'N/A'}\n\n`;
    });

    const filePath = path.join(__dirname, `receipt_${userId}_${Date.now()}.txt`);
    fs.writeFileSync(filePath, receiptText);

    await ctx.replyWithDocument({
      source: createReadStream(filePath),
      filename: `DirectPay_Receipt_Wallet${walletIndex + 1}.txt`
    });

    await unlinkAsync(filePath);
    await ctx.answerCbQuery('Receipt exported.');
  } catch (error) {
    logger.error(`Error exporting receipt for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Error exporting receipt. Try again later.'
      : '❌ Error exporting receipt. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
  }
});

// =================== Settings Handler ===================
bot.hears('⚙️ Settings', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    const userState = await getUserState(userId);
    const settingsMsg = userState.usePidgin
      ? '⚙️ *Settings*\n\nPick option below:'
      : '⚙️ *Settings*\n\nChoose an option below:';
    await ctx.replyWithMarkdown(settingsMsg, getSettingsMenu());
  } catch (error) {
    logger.error(`Error in Settings handler for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Something went wrong. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
  }
});

// =================== Settings Actions ===================
bot.action('settings_generate_wallet', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    const userState = await getUserState(userId);
    if (userState.wallets.length >= MAX_WALLETS) {
      const errorMsg = userState.usePidgin
        ? `⚠️ You don reach max wallets (${MAX_WALLETS}). Check your wallets first.`
        : `⚠️ You’ve reached the max wallet limit (${MAX_WALLETS}). Check your existing wallets first.`;
      await ctx.replyWithMarkdown(errorMsg);
      await ctx.answerCbQuery();
      return;
    }

    await ctx.answerCbQuery();
    await ctx.replyWithMarkdown(userState.usePidgin
      ? '🔄 Generating new wallet. Wait small...'
      : '🔄 Generating new wallet. Please wait...');
    await ctx.telegram.sendMessage(userId, '💼 Generate Wallet', { reply_markup: getMainMenu(false, false) });
  } catch (error) {
    logger.error(`Error in settings_generate_wallet for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Something went wrong. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
  }
});

bot.action('settings_edit_bank', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    const userState = await getUserState(userId);
    if (userState.wallets.length === 0) {
      const errorMsg = userState.usePidgin
        ? '❌ No wallet dey. Click "💼 Generate Wallet" to start.'
        : '❌ You have no wallets. Generate one with "💼 Generate Wallet".';
      await ctx.replyWithMarkdown(errorMsg);
      await ctx.answerCbQuery();
      return;
    }

    let keyboard = userState.wallets.map((wallet, index) => [
      Markup.button.callback(`Wallet ${index + 1} - ${wallet.chain}${wallet.bank ? ` (${wallet.bank.bankName})` : ''}`, `edit_bank_${index}`)
    ]);
    keyboard.push([Markup.button.callback('🔙 Back to Settings', 'settings_back')]);
    const prompt = userState.usePidgin
      ? 'Pick wallet to edit bank details:'
      : 'Select wallet to edit bank details:';
    await ctx.replyWithMarkdown(prompt, Markup.inlineKeyboard(keyboard));
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in settings_edit_bank for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Something went wrong. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
  }
});

bot.action(/edit_bank_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);

  try {
    const userState = await getUserState(userId);
    if (!userState.wallets[walletIndex]) {
      const errorMsg = userState.usePidgin
        ? '❌ Wallet no dey. Start again.'
        : '❌ Invalid wallet. Please start over.';
      await ctx.replyWithMarkdown(errorMsg);
      await ctx.answerCbQuery();
      return;
    }

    ctx.session.walletIndex = walletIndex;
    await ctx.scene.enter('bank_linking_scene');
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in edit_bank for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Something went wrong. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
  }
});

bot.action('settings_rename_wallet', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    const userState = await getUserState(userId);
    if (userState.wallets.length === 0) {
      const errorMsg = userState.usePidgin
        ? '❌ No wallet dey. Click "💼 Generate Wallet" to start.'
        : '❌ You have no wallets. Generate one with "💼 Generate Wallet".';
      await ctx.replyWithMarkdown(errorMsg);
      await ctx.answerCbQuery();
      return;
    }

    let keyboard = userState.wallets.map((wallet, index) => [
      Markup.button.callback(`Wallet ${index + 1} - ${wallet.chain} (${wallet.name || 'Unnamed'})`, `rename_wallet_${index}`)
    ]);
    keyboard.push([Markup.button.callback('🔙 Back to Settings', 'settings_back')]);
    const prompt = userState.usePidgin
      ? 'Pick wallet to rename:'
      : 'Select wallet to rename:';
    await ctx.replyWithMarkdown(prompt, Markup.inlineKeyboard(keyboard));
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in settings_rename_wallet for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Something went wrong. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
  }
});

bot.action(/rename_wallet_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);

  try {
    const userState = await getUserState(userId);
    if (!userState.wallets[walletIndex]) {
      const errorMsg = userState.usePidgin
        ? '❌ Wallet no dey. Start again.'
        : '❌ Invalid wallet. Please start over.';
      await ctx.replyWithMarkdown(errorMsg);
      await ctx.answerCbQuery();
      return;
    }

    ctx.session.renameWalletIndex = walletIndex;
    const prompt = userState.usePidgin
      ? '✏️ Enter new name for this wallet (max 20 characters):'
      : '✏️ Enter a new name for this wallet (max 20 characters):';
    await ctx.replyWithMarkdown(prompt);
    ctx.session.awaitingRename = true;
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in rename_wallet for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Something went wrong. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
  }
});

bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  if (ctx.session.awaitingRename) {
    const newName = ctx.message.text.trim();
    const walletIndex = ctx.session.renameWalletIndex;

    if (!userState.wallets[walletIndex]) {
      const errorMsg = userState.usePidgin
        ? '❌ Wallet no dey. Start again.'
        : '❌ Invalid wallet. Please start over.';
      await ctx.replyWithMarkdown(errorMsg);
      delete ctx.session.awaitingRename;
      delete ctx.session.renameWalletIndex;
      return;
    }

    if (newName.length > 20) {
      const errorMsg = userState.usePidgin
        ? '❌ Name too long. Keep am under 20 characters.'
        : '❌ Name too long. Please keep it under 20 characters.';
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }

    if (!/^[a-zA-Z0-9\s]+$/.test(newName)) {
      const errorMsg = userState.usePidgin
        ? '❌ Name no fit get special characters. Use letters and numbers only.'
        : '❌ Name cannot contain special characters. Use letters and numbers only.';
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }

    userState.wallets[walletIndex].name = newName;
    await updateUserState(userId, { wallets: userState.wallets });

    const successMsg = userState.usePidgin
      ? `✅ Wallet ${walletIndex + 1} don rename to "${newName}".`
      : `✅ Wallet ${walletIndex + 1} renamed to "${newName}".`;
    await ctx.replyWithMarkdown(successMsg, getSettingsMenu());

    delete ctx.session.awaitingRename;
    delete ctx.session.renameWalletIndex;
    return;
  }

  if (ctx.message.text.toLowerCase() === 'pidgin') {
    await updateUserState(userId, { usePidgin: true });
    const successMsg = '✅ Switched to Pidgin! How I go help you now?';
    await ctx.replyWithMarkdown(successMsg, getMainMenu(userState.wallets.length > 0, userState.wallets.some(w => w.bank)));
    return;
  }
});

bot.action('settings_set_refund_address', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    const userState = await getUserState(userId);
    const prompt = userState.usePidgin
      ? '🔙 Enter your refund wallet address (EVM or Solana) or type "default" to use your primary wallet:'
      : '🔙 Enter your refund wallet address (EVM or Solana) or type "default" to use your primary wallet:';
    await ctx.replyWithMarkdown(prompt);
    ctx.session.awaitingRefundAddress = true;
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in settings_set_refund_address for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Something went wrong. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
  }
});

bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  if (ctx.session.awaitingRefundAddress) {
    const input = ctx.message.text.trim().toLowerCase();
    let refundAddress = null;

    if (input === 'default') {
      if (userState.wallets.length > 0) {
        refundAddress = userState.wallets[0].address;
      } else {
        const errorMsg = userState.usePidgin
          ? '❌ No wallet dey to set as default. Generate wallet first.'
          : '❌ No wallets available to set as default. Generate a wallet first.';
        await ctx.replyWithMarkdown(errorMsg);
        delete ctx.session.awaitingRefundAddress;
        return;
      }
    } else {
      const isValidEvm = ethers.utils.isAddress(input);
      const isValidSolana = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(input);
      if (!isValidEvm && !isValidSolana) {
        const errorMsg = userState.usePidgin
          ? '❌ Invalid wallet address. Enter valid EVM or Solana address or "default".'
          : '❌ Invalid wallet address. Please enter a valid EVM or Solana address or "default".';
        await ctx.replyWithMarkdown(errorMsg);
        return;
      }
      refundAddress = input;
    }

    await updateUserState(userId, { refundAddress });
    const successMsg = userState.usePidgin
      ? `✅ Refund address set to: \`${refundAddress}\``
      : `✅ Refund address set to: \`${refundAddress}\``;
    await ctx.replyWithMarkdown(successMsg, getSettingsMenu());

    delete ctx.session.awaitingRefundAddress;
    return;
  }
});

bot.action('settings_support', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    const userState = await getUserState(userId);
    const supportMsg = userState.usePidgin
      ? '📞 *Support*\n\nContact us for help:\n👤 Telegram: [@maxcswap](https://t.me/maxcswap)\n📧 Email: support@directpay.ng'
      : '📞 *Support*\n\nContact us for assistance:\n👤 Telegram: [@maxcswap](https://t.me/maxcswap)\n📧 Email: support@directpay.ng';
    await ctx.replyWithMarkdown(supportMsg);
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in settings_support for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Something went wrong. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
  }
});

bot.action('settings_back', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    const userState = await getUserState(userId);
    const settingsMsg = userState.usePidgin
      ? '⚙️ *Settings*\n\nPick option below:'
      : '⚙️ *Settings*\n\nChoose an option below:';
    await ctx.editMessageText(settingsMsg, {
      parse_mode: 'Markdown',
      reply_markup: getSettingsMenu()
    });
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in settings_back for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Something went wrong. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
  }
});

bot.action('settings_back_main', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    const userState = await getUserState(userId);
    const walletExists = userState.wallets.length > 0;
    const hasBankLinked = userState.wallets.some(wallet => wallet.bank);
    await ctx.editMessageText(userState.usePidgin
      ? '🏠 *Main Menu*\n\nWetins you wan do?'
      : '🏠 *Main Menu*\n\nWhat would you like to do?', {
      parse_mode: 'Markdown',
      reply_markup: getMainMenu(walletExists, hasBankLinked)
    });
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in settings_back_main for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Something went wrong. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
  }
});

// =================== Back to Main Menu ===================
bot.action('back_to_main', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    const userState = await getUserState(userId);
    const walletExists = userState.wallets.length > 0;
    const hasBankLinked = userState.wallets.some(wallet => wallet.bank);
    await ctx.editMessageText(userState.usePidgin
      ? '🏠 *Main Menu*\n\nWetins you wan do?'
      : '🏠 *Main Menu*\n\nWhat would you like to do?', {
      parse_mode: 'Markdown',
      reply_markup: getMainMenu(walletExists, hasBankLinked)
    });
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in back_to_main for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Something went wrong. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
  }
});

// =================== Bridge & Cash Out Handler ===================
bot.hears('🌉 Bridge & Cash Out', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    const userState = await getUserState(userId);
    const bridgeMsg = userState.usePidgin
      ? '🌉 *Bridge & Cash Out*\n\n' +
        'Send USDC or USDT to your wallet address (Base, Polygon, BNB Smart Chain, or Solana).\n\n' +
        '• We go bridge your Solana USDC/USDT to Base USDC automatically.\n' +
        '• Your cash go land your linked bank account as NGN.\n\n' +
        '*Current Rates:*\n' +
        Object.entries(exchangeRates).map(([asset, rate]) => `• ${asset}: ₦${rate}`).join('\n') + '\n\n' +
        'Check your wallet address in "💼 View Wallet" and send funds.'
      : '🌉 *Bridge & Cash Out*\n\n' +
        'Send USDC or USDT to your wallet address (Base, Polygon, BNB Smart Chain, or Solana).\n\n' +
        '• Solana USDC/USDT will be bridged to Base USDC automatically.\n' +
        '• Your cash will be sent to your linked bank account in NGN.\n\n' +
        '*Current Rates:*\n' +
        Object.entries(exchangeRates).map(([asset, rate]) => `• ${asset}: ₦${rate}`).join('\n') + '\n\n' +
        'View your wallet address in "💼 View Wallet" and send funds.';
    await ctx.replyWithMarkdown(bridgeMsg);
  } catch (error) {
    logger.error(`Error in Bridge & Cash Out handler for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Something went wrong. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
  }
});

// =================== Support Handler ===================
bot.hears('ℹ️ Support', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    const userState = await getUserState(userId);
    const supportMsg = userState.usePidgin
      ? '📞 *Support*\n\nContact us for help:\n👤 Telegram: [@maxcswap](https://t.me/maxcswap)\n📧 Email: support@directpay.ng'
      : '📞 *Support*\n\nContact us for assistance:\n👤 Telegram: [@maxcswap](https://t.me/maxcswap)\n📧 Email: support@directpay.ng';
    await ctx.replyWithMarkdown(supportMsg);
  } catch (error) {
    logger.error(`Error in Support handler for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Something went wrong. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
  }
});

// =================== View Current Rates Handler ===================
bot.hears('📈 View Current Rates', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    const userState = await getUserState(userId);
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
  } catch (error) {
    logger.error(`Error in View Current Rates handler for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Something went wrong. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
  }
});

// =================== Admin Panel ===================
bot.action('open_admin_panel', async (ctx) => {
  const userId = ctx.from.id.toString();

  if (!isAdmin(userId)) {
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ You no be admin. No try am.'
      : '❌ You are not an admin. Access denied.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
    return;
  }

  try {
    const userState = await getUserState(userId);
    const adminMsg = userState.usePidgin
      ? '🔧 *Admin Panel*\n\nPick option below:'
      : '🔧 *Admin Panel*\n\nChoose an option below:';
    await ctx.editMessageText(adminMsg, {
      parse_mode: 'Markdown',
      reply_markup: getAdminMenu()
    });
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in open_admin_panel for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Something went wrong. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
  }
});

bot.action('admin_view_all_transactions', async (ctx) => {
  const userId = ctx.from.id.toString();

  if (!isAdmin(userId)) {
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ You no be admin. No try am.'
      : '❌ You are not an admin. Access denied.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
    return;
  }

  try {
    const userState = await getUserState(userId);
    const transactionsSnapshot = await db.collection('transactions')
      .orderBy('timestamp', 'desc')
      .limit(10)
      .get();

    if (transactionsSnapshot.empty) {
      const noTxMsg = userState.usePidgin
        ? 'No transactions dey yet.'
        : 'No transactions found yet.';
      await ctx.replyWithMarkdown(noTxMsg);
      await ctx.answerCbQuery();
      return;
    }

    let message = userState.usePidgin
      ? '💰 *Recent Transactions*\n\n'
      : '💰 *Recent Transactions*\n\n';
    transactionsSnapshot.forEach((doc) => {
      const tx = doc.data();
      message += `*Transaction ${tx.referenceId || 'N/A'}:*\n`;
      message += `• *User ID:* ${tx.userId || 'N/A'}\n`;
      message += `• *Amount:* ${tx.amount || 'N/A'} ${tx.asset || 'N/A'}\n`;
      message += `• *Status:* ${tx.status || 'Pending'}\n`;
      message += `• *Chain:* ${tx.chain || 'N/A'}\n`;
      message += `• *Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n\n`;
    });

    await ctx.replyWithMarkdown(message, Markup.inlineKeyboard([
      [Markup.button.callback('🔙 Back to Admin Panel', 'open_admin_panel')]
    ]));
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in admin_view_all_transactions for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Something went wrong. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
  }
});

bot.action('admin_view_users', async (ctx) => {
  const userId = ctx.from.id.toString();

  if (!isAdmin(userId)) {
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ You no be admin. No try am.'
      : '❌ You are not an admin. Access denied.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
    return;
  }

  try {
    const userState = await getUserState(userId);
    const usersSnapshot = await db.collection('users').limit(10).get();

    if (usersSnapshot.empty) {
      const noUsersMsg = userState.usePidgin
        ? 'No users dey yet.'
        : 'No users found yet.';
      await ctx.replyWithMarkdown(noUsersMsg);
      await ctx.answerCbQuery();
      return;
    }

    let message = userState.usePidgin
      ? '👥 *Recent Users*\n\n'
      : '👥 *Recent Users*\n\n';
    usersSnapshot.forEach((doc) => {
      const user = doc.data();
      message += `*User ID:* ${doc.id}\n`;
      message += `• *Name:* ${user.firstName || 'Unknown'}\n`;
      message += `• *Wallets:* ${user.wallets ? user.wallets.length : 0}\n`;
      message += `• *Has Bank:* ${user.wallets.some(w => w.bank) ? 'Yes' : 'No'}\n\n`;
    });

    await ctx.replyWithMarkdown(message, Markup.inlineKeyboard([
      [Markup.button.callback('🔙 Back to Admin Panel', 'open_admin_panel')]
    ]));
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in admin_view_users for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Something went wrong. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
  }
});

bot.action('admin_pending_issues', async (ctx) => {
  const userId = ctx.from.id.toString();

  if (!isAdmin(userId)) {
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ You no be admin. No try am.'
      : '❌ You are not an admin. Access denied.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
    return;
  }

  try {
    const userState = await getUserState(userId);
    const transactionsSnapshot = await db.collection('transactions')
      .where('status', 'in', ['Pending', 'Failed'])
      .orderBy('timestamp', 'desc')
      .limit(10)
      .get();

    if (transactionsSnapshot.empty) {
      const noIssuesMsg = userState.usePidgin
        ? 'No pending issues dey.'
        : 'No pending issues found.';
      await ctx.replyWithMarkdown(noIssuesMsg);
      await ctx.answerCbQuery();
      return;
    }

    let message = userState.usePidgin
      ? '⏳ *Pending/Failed Transactions*\n\n'
      : '⏳ *Pending/Failed Transactions*\n\n';
    transactionsSnapshot.forEach((doc) => {
      const tx = doc.data();
      message += `*Transaction ${tx.referenceId || 'N/A'}:*\n`;
      message += `• *User ID:* ${tx.userId || 'N/A'}\n`;
      message += `• *Amount:* ${tx.amount || 'N/A'} ${tx.asset || 'N/A'}\n`;
      message += `• *Status:* ${tx.status || 'Unknown'}\n`;
      message += `• *Chain:* ${tx.chain || 'N/A'}\n`;
      message += `• *Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n\n`;
    });

    await ctx.replyWithMarkdown(message, Markup.inlineKeyboard([
      [Markup.button.callback('🔙 Back to Admin Panel', 'open_admin_panel')]
    ]));
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in admin_pending_issues for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Something went wrong. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
  }
});

bot.action('admin_send_message', async (ctx) => {
  const userId = ctx.from.id.toString();

  if (!isAdmin(userId)) {
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ You no be admin. No try am.'
      : '❌ You are not an admin. Access denied.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
    return;
  }

  try {
    await ctx.scene.enter('send_message_scene');
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in admin_send_message for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Something went wrong. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
  }
});

bot.action('admin_manual_payout', async (ctx) => {
  const userId = ctx.from.id.toString();

  if (!isAdmin(userId)) {
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ You no be admin. No try am.'
      : '❌ You are not an admin. Access denied.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
    return;
  }

  try {
    const userState = await getUserState(userId);
    const prompt = userState.usePidgin
      ? '💰 Enter details for manual payout (User ID, Amount, Asset, Bank Details):'
      : '💰 Enter details for manual payout (User ID, Amount, Asset, Bank Details):';
    await ctx.replyWithMarkdown(prompt);
    ctx.session.awaitingManualPayout = true;
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in admin_manual_payout for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Something went wrong. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
  }
});

bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  if (ctx.session.awaitingManualPayout && isAdmin(userId)) {
    const input = ctx.message.text.trim();
    // Example format: "UserID:12345 Amount:100 Asset:USDC Bank:GTBank Account:0123456789"
    try {
      const parts = input.split(' ');
      const userIdToPayout = parts.find(p => p.startsWith('UserID:'))?.split(':')[1];
      const amountStr = parts.find(p => p.startsWith('Amount:'))?.split(':')[1];
      const asset = parts.find(p => p.startsWith('Asset:'))?.split(':')[1];
      const bankName = parts.find(p => p.startsWith('Bank:'))?.split(':')[1];
      const accountNumber = parts.find(p => p.startsWith('Account:'))?.split(':')[1];

      if (!userIdToPayout || !amountStr || !asset || !bankName || !accountNumber) {
        const errorMsg = userState.usePidgin
          ? '❌ Format no correct. Use: UserID:12345 Amount:100 Asset:USDC Bank:GTBank Account:0123456789'
          : '❌ Invalid format. Use: UserID:12345 Amount:100 Asset:USDC Bank:GTBank Account:0123456789';
        await ctx.replyWithMarkdown(errorMsg);
        return;
      }

      const amount = parseFloat(amountStr);
      if (isNaN(amount) || amount <= 0) {
        const errorMsg = userState.usePidgin
          ? '❌ Amount no valid. Enter correct number.'
          : '❌ Invalid amount. Please enter a valid number.';
        await ctx.replyWithMarkdown(errorMsg);
        return;
      }

      if (!SUPPORTED_ASSETS.includes(asset)) {
        const errorMsg = userState.usePidgin
          ? `❌ Asset no supported. Use ${SUPPORTED_ASSETS.join(' or ')}.`
          : `❌ Unsupported asset. Please use ${SUPPORTED_ASSETS.join(' or ')}.`;
        await ctx.replyWithMarkdown(errorMsg);
        return;
      }

      const bank = bankList.find(b => b.name.toLowerCase() === bankName.toLowerCase());
      if (!bank) {
        const errorMsg = userState.usePidgin
          ? '❌ Bank no supported. Check bank list.'
          : '❌ Unsupported bank. Please check the supported bank list.';
        await ctx.replyWithMarkdown(errorMsg);
        return;
      }

      const verificationResult = await verifyBankAccount(accountNumber, bank.code);
      if (!verificationResult.data.account_name) {
        const errorMsg = userState.usePidgin
          ? '❌ Cannot verify account. Check details.'
          : '❌ Failed to verify account. Please check the details.';
        await ctx.replyWithMarkdown(errorMsg);
        return;
      }

      const recipientDetails = {
        bankName: bank.name,
        bankCode: bank.code,
        accountNumber,
        accountName: verificationResult.data.account_name
      };

      const referenceId = generateReferenceId();
      const payoutAmount = calculatePayout(asset, amount);

      const order = await createPaycrestOrder(userIdToPayout, payoutAmount, asset, 'Base', recipientDetails, PAYCREST_RETURN_ADDRESS);

      await db.collection('transactions').doc(referenceId).set({
        userId: userIdToPayout,
        walletAddress: 'Manual Payout',
        amount,
        asset,
        payoutAmount,
        chain: 'Base',
        status: 'Pending',
        referenceId,
        timestamp: new Date().toISOString(),
        bankDetails: recipientDetails
      });

      const successMsg = userState.usePidgin
        ? `✅ Manual payout started for User ${userIdToPayout}:\n` +
          `• Amount: ${amount} ${asset}\n` +
          `• Payout: ₦${payoutAmount}\n` +
          `• Bank: ${bank.name} (****${accountNumber.slice(-4)})\n` +
          `• Ref ID: ${referenceId}`
        : `✅ Manual payout initiated for User ${userIdToPayout}:\n` +
          `• Amount: ${amount} ${asset}\n` +
          `• Payout: ₦${payoutAmount}\n` +
          `• Bank: ${bank.name} (****${accountNumber.slice(-4)})\n` +
          `• Ref ID: ${referenceId}`;
      await ctx.replyWithMarkdown(successMsg);

      await bot.telegram.sendMessage(userIdToPayout, userState.usePidgin
        ? `💸 *Payout Started*\n\n` +
          `We don start payout of ₦${payoutAmount} to your bank (${bank.name} ****${accountNumber.slice(-4)}).\n` +
          `• Ref ID: ${referenceId}\n` +
          `• Amount: ${amount} ${asset}\n` +
          `Check your bank soon!`
        : `💸 *Payout Initiated*\n\n` +
          `We’ve initiated a payout of ₦${payoutAmount} to your bank (${bank.name} ****${accountNumber.slice(-4)}).\n` +
          `• Ref ID: ${referenceId}\n` +
          `• Amount: ${amount} ${asset}\n` +
          `Check your bank account soon!`, { parse_mode: 'Markdown' });

      delete ctx.session.awaitingManualPayout;
    } catch (error) {
      logger.error(`Error processing manual payout for user ${userId}: ${error.message}`);
      const errorMsg = userState.usePidgin
        ? '❌ Error starting payout. Try again or contact support.'
        : '❌ Error initiating payout. Try again or contact support.';
      await ctx.replyWithMarkdown(errorMsg);
    }
    return;
  }
});

bot.action('admin_refund_tx', async (ctx) => {
  const userId = ctx.from.id.toString();

  if (!isAdmin(userId)) {
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ You no be admin. No try am.'
      : '❌ You are not an admin. Access denied.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
    return;
  }

  try {
    const userState = await getUserState(userId);
    const prompt = userState.usePidgin
      ? '🔙 Enter Transaction Reference ID to refund:'
      : '🔙 Enter Transaction Reference ID to refund:';
    await ctx.replyWithMarkdown(prompt);
    ctx.session.awaitingRefundTx = true;
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in admin_refund_tx for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Something went wrong. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
  }
});

bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  if (ctx.session.awaitingRefundTx && isAdmin(userId)) {
    const referenceId = ctx.message.text.trim();

    try {
      const txDoc = await db.collection('transactions').doc(referenceId).get();
      if (!txDoc.exists) {
        const errorMsg = userState.usePidgin
          ? '❌ Transaction no dey. Check Ref ID.'
          : '❌ Transaction not found. Please check the Reference ID.';
        await ctx.replyWithMarkdown(errorMsg);
        return;
      }

      const tx = txDoc.data();
      if (tx.status !== 'Failed') {
        const errorMsg = userState.usePidgin
          ? '❌ This transaction no fail, so no fit refund.'
          : '❌ This transaction is not failed, so it cannot be refunded.';
        await ctx.replyWithMarkdown(errorMsg);
        return;
      }

      const user = await getUserState(tx.userId);
      const refundAddress = user.refundAddress || tx.walletAddress;
      const chainKey = chainMapping[tx.chain.toLowerCase()] || 'Base';
      const chainData = chains[chainKey];
      if (!chainData) {
        const errorMsg = userState.usePidgin
          ? '❌ Chain no supported for refund.'
          : '❌ Unsupported chain for refund.';
        await ctx.replyWithMarkdown(errorMsg);
        return;
      }

      const assetId = chainData.assets[tx.asset];
      if (!assetId) {
        const errorMsg = userState.usePidgin
          ? `❌ Asset ${tx.asset} no supported on ${tx.chain}.`
          : `❌ Asset ${tx.asset} not supported on ${tx.chain}.`;
        await ctx.replyWithMarkdown(errorMsg);
        return;
      }

      const withdrawResponse = await withdrawFromBlockradar(
        chainKey,
        assetId,
        refundAddress,
        tx.amount,
        referenceId,
        { type: 'refund', userId: tx.userId }
      );

      await db.collection('transactions').doc(referenceId).update({
        status: 'Refunded',
        refundAddress,
        refundTimestamp: new Date().toISOString()
      });

      const successMsg = userState.usePidgin
        ? `✅ Refund done for ${tx.amount} ${tx.asset} to ${refundAddress} (Ref ID: ${referenceId}).`
        : `✅ Refund processed for ${tx.amount} ${tx.asset} to ${refundAddress} (Ref ID: ${referenceId}).`;
      await ctx.replyWithMarkdown(successMsg);

      await bot.telegram.sendMessage(tx.userId, userState.usePidgin
        ? `🔙 *Refund Done*\n\n` +
          `We don refund ${tx.amount} ${tx.asset} to your wallet: \`${refundAddress}\`.\n` +
          `• Ref ID: ${referenceId}\n` +
          `Sorry for any wahala!`
        : `🔙 *Refund Processed*\n\n` +
          `We’ve refunded ${tx.amount} ${tx.asset} to your wallet: \`${refundAddress}\`.\n` +
          `• Ref ID: ${referenceId}\n` +
          `Sorry for any inconvenience!`, { parse_mode: 'Markdown' });

      delete ctx.session.awaitingRefundTx;
    } catch (error) {
      logger.error(`Error processing refund for user ${userId}, Ref ID ${referenceId}: ${error.message}`);
      const errorMsg = userState.usePidgin
        ? '❌ Error doing refund. Try again or contact support.'
        : '❌ Error processing refund. Try again or contact support.';
      await ctx.replyWithMarkdown(errorMsg);
    }
    return;
  }
});

bot.action('admin_api_status', async (ctx) => {
  const userId = ctx.from.id.toString();

  if (!isAdmin(userId)) {
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ You no be admin. No try am.'
      : '❌ You are not an admin. Access denied.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
    return;
  }

  try {
    const userState = await getUserState(userId);
    let statusMessage = userState.usePidgin
      ? '⚠️ *API/Bot Status*\n\n'
      : '⚠️ *API/Bot Status*\n\n';

    // Check Paycrest API
    try {
      await axios.get(PAYCREST_RATE_API_URL, {
        headers: { 'Authorization': `Bearer ${PAYCREST_API_KEY}` }
      });
      statusMessage += '• *Paycrest API*: ✅ Online\n';
    } catch (error) {
      statusMessage += '• *Paycrest API*: ❌ Offline\n';
      logger.error(`Paycrest API check failed: ${error.message}`);
    }

    // Check Blockradar API for each chain
    for (const [chainName, chainData] of Object.entries(chains)) {
      try {
        await axios.get(chainData.apiUrl, {
          headers: { 'x-api-key': chainData.key }
        });
        statusMessage += `• *Blockradar ${chainName}*: ✅ Online\n`;
      } catch (error) {
        statusMessage += `• *Blockradar ${chainName}*: ❌ Offline\n`;
        logger.error(`Blockradar ${chainName} API check failed: ${error.message}`);
      }
    }

    // Check Relay.link API
    try {
      await axios.get(RELAY_API_URL);
      statusMessage += '• *Relay.link API*: ✅ Online\n';
    } catch (error) {
      statusMessage += '• *Relay.link API*: ❌ Offline\n';
      logger.error(`Relay.link API check failed: ${error.message}`);
    }

    statusMessage += userState.usePidgin
      ? `\nBot dey work fine!`
      : `\nBot is operational!`;
    await ctx.replyWithMarkdown(statusMessage, Markup.inlineKeyboard([
      [Markup.button.callback('🔙 Back to Admin Panel', 'open_admin_panel')]
    ]));
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in admin_api_status for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Something went wrong. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
  }
});

bot.action('admin_back_to_main', async (ctx) => {
  const userId = ctx.from.id.toString();

  try {
    const userState = await getUserState(userId);
    const walletExists = userState.wallets.length > 0;
    const hasBankLinked = userState.wallets.some(wallet => wallet.bank);
    await ctx.editMessageText(userState.usePidgin
      ? '🏠 *Main Menu*\n\nWetins you wan do?'
      : '🏠 *Main Menu*\n\nWhat would you like to do?', {
      parse_mode: 'Markdown',
      reply_markup: getMainMenu(walletExists, hasBankLinked)
    });
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in admin_back_to_main for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Something went wrong. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
  }
});

// =================== Paycrest Webhook Handler ===================
async function handlePaycrestWebhook(req, res) {
  try {
    const rawBody = req.rawBody || req.body;
    const signature = req.headers['x-paycrest-signature'];
    if (!signature) {
      logger.error('Paycrest webhook: Missing signature header');
      return res.status(401).json({ error: 'Missing signature' });
    }

    const isValid = verifyPaycrestSignature(JSON.stringify(rawBody), signature, PAYCREST_CLIENT_SECRET);
    if (!isValid) {
      logger.error('Paycrest webhook: Invalid signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const payload = rawBody;
    const { event, data } = payload;
    logger.info(`Received Paycrest webhook event: ${event}`);

    if (event === 'order.completed') {
      const { reference, status, amount, token, network } = data;
      const txDoc = await db.collection('transactions').doc(reference).get();
      if (!txDoc.exists) {
        logger.error(`Paycrest webhook: Transaction ${reference} not found`);
        return res.status(404).json({ error: 'Transaction not found' });
      }

      const tx = txDoc.data();
      const userState = await getUserState(tx.userId);

      if (status === 'completed') {
        await db.collection('transactions').doc(reference).update({
          status: 'Completed',
          payoutTimestamp: new Date().toISOString()
        });

        const walletIndex = userState.wallets.findIndex(w => w.address === tx.walletAddress || w.solanaAddress === tx.walletAddress);
        if (walletIndex !== -1) {
          userState.wallets[walletIndex].totalPayouts = (userState.wallets[walletIndex].totalPayouts || 0) + tx.payoutAmount;
          await updateUserState(tx.userId, { wallets: userState.wallets });
        }

        const successMsg = userState.usePidgin
          ? `💸 *Payout Done*\n\n` +
            `You don receive ₦${tx.payoutAmount} in your bank (${tx.bankDetails.bankName} ****${tx.bankDetails.accountNumber.slice(-4)}).\n` +
            `• Ref ID: ${reference}\n` +
            `• Amount: ${tx.amount} ${tx.asset}\n` +
            `• Rate: ₦${exchangeRates[tx.asset]} per ${tx.asset}\n` +
            `Check "💰 Transactions" for receipt!`
          : `💸 *Payout Completed*\n\n` +
            `You’ve received ₦${tx.payoutAmount} in your bank (${tx.bankDetails.bankName} ****${tx.bankDetails.accountNumber.slice(-4)}).\n` +
            `• Ref ID: ${reference}\n` +
            `• Amount: ${tx.amount} ${tx.asset}\n` +
            `• Rate: ₦${exchangeRates[tx.asset]} per ${tx.asset}\n` +
            `Check "💰 Transactions" for your receipt!`;
        await bot.telegram.sendPhoto(tx.userId, { source: PAYOUT_SUCCESS_IMAGE }, {
          caption: successMsg,
          parse_mode: 'Markdown'
        });

        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `✅ Payout completed for user ${tx.userId}:\n` +
          `• Ref ID: ${reference}\n` +
          `• Amount: ${tx.amount} ${tx.asset}\n` +
          `• Payout: ₦${tx.payoutAmount}\n` +
          `• Bank: ${tx.bankDetails.bankName} (****${tx.bankDetails.accountNumber.slice(-4)})`, { parse_mode: 'Markdown' });

        logger.info(`Paycrest webhook: Payout completed for transaction ${reference}`);
      }
    } else if (event === 'order.failed') {
      const { reference, reason } = data;
      const txDoc = await db.collection('transactions').doc(reference).get();
      if (!txDoc.exists) {
        logger.error(`Paycrest webhook: Transaction ${reference} not found`);
        return res.status(404).json({ error: 'Transaction not found' });
      }

      const tx = txDoc.data();
      const userState = await getUserState(tx.userId);

      await db.collection('transactions').doc(reference).update({
        status: 'Failed',
        failureReason: reason || 'Unknown',
        failureTimestamp: new Date().toISOString()
      });

      const refundAddress = userState.refundAddress || tx.walletAddress;
      const chainKey = chainMapping[tx.chain.toLowerCase()] || 'Base';
      const chainData = chains[chainKey];
      if (chainData && chainData.assets[tx.asset]) {
        try {
          await withdrawFromBlockradar(
            chainKey,
            chainData.assets[tx.asset],
            refundAddress,
            tx.amount,
            reference,
            { type: 'refund', userId: tx.userId }
          );

          await db.collection('transactions').doc(reference).update({
            status: 'Refunded',
            refundAddress,
            refundTimestamp: new Date().toISOString()
          });

          const refundMsg = userState.usePidgin
            ? `🔙 *Payout Fail - Refund Done*\n\n` +
              `Payout of ₦${tx.payoutAmount} fail because: ${reason || 'Unknown'}.\n` +
              `We don refund ${tx.amount} ${tx.asset} to \`${refundAddress}\`.\n` +
              `• Ref ID: ${reference}\n` +
              `Contact [@maxcswap](https://t.me/maxcswap) if you need help!`
            : `🔙 *Payout Failed - Refund Processed*\n\n` +
              `Payout of ₦${tx.payoutAmount} failed due to: ${reason || 'Unknown'}.\n` +
              `We’ve refunded ${tx.amount} ${tx.asset} to \`${refundAddress}\`.\n` +
              `• Ref ID: ${reference}\n` +
              `Contact [@maxcswap](https://t.me/maxcswap) for assistance!`;
          await bot.telegram.sendPhoto(tx.userId, { source: ERROR_IMAGE }, {
            caption: refundMsg,
            parse_mode: 'Markdown'
          });

          await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Payout failed for user ${tx.userId}, refunded:\n` +
            `• Ref ID: ${reference}\n` +
            `• Amount: ${tx.amount} ${tx.asset}\n` +
            `• Refund Address: ${refundAddress}\n` +
            `• Reason: ${reason || 'Unknown'}`, { parse_mode: 'Markdown' });
        } catch (refundError) {
          logger.error(`Paycrest webhook: Failed to refund transaction ${reference}: ${refundError.message}`);
          const errorMsg = userState.usePidgin
            ? `❌ Payout fail and refund no work: ${reason || 'Unknown'}.\n` +
              `• Ref ID: ${reference}\n` +
              `Contact [@maxcswap](https://t.me/maxcswap) sharp sharp!`
            : `❌ Payout failed and refund could not be processed: ${reason || 'Unknown'}.\n` +
              `• Ref ID: ${reference}\n` +
              `Please contact [@maxcswap](https://t.me/maxcswap) immediately!`;
          await bot.telegram.sendPhoto(tx.userId, { source: ERROR_IMAGE }, {
            caption: errorMsg,
            parse_mode: 'Markdown'
          });

          await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🚨 Critical: Payout and refund failed for user ${tx.userId}:\n` +
            `• Ref ID: ${reference}\n` +
            `• Amount: ${tx.amount} ${tx.asset}\n` +
            `• Reason: ${reason || 'Unknown'}\n` +
            `• Refund Error: ${refundError.message}`, { parse_mode: 'Markdown' });
        }
      } else {
        const errorMsg = userState.usePidgin
          ? `❌ Payout fail: ${reason || 'Unknown'}.\n` +
            `• Ref ID: ${reference}\n` +
            `Chain or asset no supported for refund. Contact [@maxcswap](https://t.me/maxcswap).`
          : `❌ Payout failed: ${reason || 'Unknown'}.\n` +
            `• Ref ID: ${reference}\n` +
            `Chain or asset not supported for refund. Contact [@maxcswap](https://t.me/maxcswap).`;
        await bot.telegram.sendPhoto(tx.userId, { source: ERROR_IMAGE }, {
          caption: errorMsg,
          parse_mode: 'Markdown'
        });

        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Payout failed for user ${tx.userId}, no refund possible:\n` +
          `• Ref ID: ${reference}\n` +
          `• Amount: ${tx.amount} ${tx.asset}\n` +
          `• Reason: ${reason || 'Unknown'}\n` +
          `• Chain: ${tx.chain}`, { parse_mode: 'Markdown' });
      }

      logger.info(`Paycrest webhook: Transaction ${reference} failed, processed refund or notified user`);
    }

    return res.status(200).json({ status: 'success' });
  } catch (error) {
    logger.error(`Paycrest webhook error: ${error.message}`);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// =================== Blockradar Webhook Handler ===================
app.post(WEBHOOK_BLOCKRADAR_PATH, async (req, res) => {
  try {
    const payload = req.body;
    const { event, data } = payload;
    logger.info(`Received Blockradar webhook event: ${event}`);

    if (event === 'deposit.success' || event === 'deposit.swept.success') {
      const {
        address,
        amount,
        assetId,
        transactionHash,
        chain,
        tokenAddress
      } = data;

      // Validate payload
      if (!address || !amount || !assetId || !transactionHash || !chain) {
        logger.error(`Blockradar webhook: Missing required fields in payload: ${JSON.stringify(data)}`);
        return res.status(400).json({ error: 'Missing required fields' });
      }

      // Map chain to internal representation
      const chainKey = chainMapping[chain.toLowerCase()];
      if (!chainKey || !chains[chainKey]) {
        logger.error(`Blockradar webhook: Unsupported chain: ${chain}`);
        return res.status(400).json({ error: `Unsupported chain: ${chain}` });
      }

      const chainData = chains[chainKey];
      let asset;
      // Identify asset based on assetId or tokenAddress
      if (chainKey === 'Solana') {
        asset = Object.values(SOLANA_TOKENS).find(token => token.address === tokenAddress)?.symbol;
      } else {
        asset = Object.keys(chainData.assets).find(key => chainData.assets[key] === assetId);
      }

      if (!asset || !SUPPORTED_ASSETS.includes(asset)) {
        logger.error(`Blockradar webhook: Unsupported asset for assetId ${assetId} or tokenAddress ${tokenAddress} on chain ${chain}`);
        return res.status(400).json({ error: 'Unsupported asset' });
      }

      // Find user by wallet address
      const userSnapshot = await db.collection('users')
        .where('walletAddresses', 'array-contains', address)
        .limit(1)
        .get();

      if (userSnapshot.empty) {
        logger.error(`Blockradar webhook: No user found for address ${address}`);
        return res.status(404).json({ error: 'User not found for address' });
      }

      const userDoc = userSnapshot.docs[0];
      const userId = userDoc.id;
      const userState = await getUserState(userId);
      const walletIndex = userState.wallets.findIndex(w => w.address === address || w.solanaAddress === address);
      if (walletIndex === -1) {
        logger.error(`Blockradar webhook: Wallet not found for address ${address} in user ${userId}`);
        return res.status(404).json({ error: 'Wallet not found' });
      }

      const wallet = userState.wallets[walletIndex];
      if (!wallet.bank) {
        logger.warn(`Blockradar webhook: No bank linked for user ${userId}, address ${address}`);
        const noBankMsg = userState.usePidgin
          ? `⚠️ *Deposit Seen*\n\n` +
            `We see your deposit of ${amount} ${asset} on ${chainKey} (Tx: \`${transactionHash}\`).\n` +
            `But you no link bank yet. Go to "⚙️ Settings" to link bank so we fit pay you!`
          : `⚠️ *Deposit Detected*\n\n` +
            `We’ve detected your deposit of ${amount} ${asset} on ${chainKey} (Tx: \`${transactionHash}\`).\n` +
            `However, you haven’t linked a bank account. Link one in "⚙️ Settings" to receive your payout!`;
        await bot.telegram.sendMessage(userId, noBankMsg, { parse_mode: 'Markdown' });
        return res.status(200).json({ status: 'success', message: 'Awaiting bank linking' });
      }

      // Calculate payout
      const payoutAmount = calculatePayout(asset, amount);

      // Generate reference ID
      const referenceId = generateReferenceId();

      // Store transaction
      await db.collection('transactions').doc(referenceId).set({
        userId,
        walletAddress: address,
        amount: parseFloat(amount),
        asset,
        payoutAmount,
        chain: chainKey,
        status: 'Pending',
        referenceId,
        transactionHash,
        timestamp: new Date().toISOString(),
        bankDetails: wallet.bank
      });

      // Update wallet stats
      userState.wallets[walletIndex].totalDeposits = (userState.wallets[walletIndex].totalDeposits || 0) + parseFloat(amount);
      userState.hasReceivedDeposit = true;
      await updateUserState(userId, {
        wallets: userState.wallets,
        hasReceivedDeposit: true
      });

      // Notify user of deposit
      const depositMsg = userState.usePidgin
        ? `✅ *Deposit Seen*\n\n` +
          `We don see your ${amount} ${asset} deposit on ${chainKey} (Tx: \`${transactionHash}\`).\n` +
          `We go pay ₦${payoutAmount} to your bank (${wallet.bank.bankName} ****${wallet.bank.accountNumber.slice(-4)}).\n` +
          `• Ref ID: ${referenceId}\n` +
          `You go see alert soon!`
        : `✅ *Deposit Detected*\n\n` +
          `We’ve received your ${amount} ${asset} deposit on ${chainKey} (Tx: \`${transactionHash}\`).\n` +
          `We’ll send ₦${payoutAmount} to your bank (${wallet.bank.bankName} ****${wallet.bank.accountNumber.slice(-4)}).\n` +
          `• Ref ID: ${referenceId}\n` +
          `Expect your payout soon!`;
      await bot.telegram.sendPhoto(userId, { source: DEPOSIT_SUCCESS_IMAGE }, {
        caption: depositMsg,
        parse_mode: 'Markdown'
      });

      // Notify admin
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `💰 New deposit for user ${userId}:\n` +
        `• Amount: ${amount} ${asset}\n` +
        `• Chain: ${chainKey}\n` +
        `• Address: ${address}\n` +
        `• Tx: ${transactionHash}\n` +
        `• Payout: ₦${payoutAmount}\n` +
        `• Ref ID: ${referenceId}`, { parse_mode: 'Markdown' });

      // Initiate Paycrest order
      try {
        const order = await createPaycrestOrder(
          userId,
          payoutAmount,
          asset,
          chainKey,
          wallet.bank,
          userState.refundAddress || wallet.address
        );

        // Update transaction with Paycrest order details
        await db.collection('transactions').doc(referenceId).update({
          paycrestOrderId: order.orderId,
          status: 'Processing'
        });

        logger.info(`Blockradar webhook: Deposit processed, Paycrest order created for ${referenceId}`);
      } catch (paycrestError) {
        logger.error(`Blockradar webhook: Failed to create Paycrest order for ${referenceId}: ${paycrestError.message}`);
        await db.collection('transactions').doc(referenceId).update({
          status: 'Failed',
          failureReason: paycrestError.message,
          failureTimestamp: new Date().toISOString()
        });

        // Attempt refund
        try {
          await withdrawFromBlockradar(
            chainKey,
            chainData.assets[asset],
            userState.refundAddress || wallet.address,
            amount,
            referenceId,
            { type: 'refund', userId }
          );

          await db.collection('transactions').doc(referenceId).update({
            status: 'Refunded',
            refundAddress: userState.refundAddress || wallet.address,
            refundTimestamp: new Date().toISOString()
          });

          const refundMsg = userState.usePidgin
            ? `🔙 *Deposit Fail - Refund Done*\n\n` +
              `We no fit process your ${amount} ${asset} deposit (Tx: \`${transactionHash}\`).\n` +
              `We don refund am to \`${userState.refundAddress || wallet.address}\`.\n` +
              `• Ref ID: ${referenceId}\n` +
              `Contact [@maxcswap](https://t.me/maxcswap) if you need help!`
            : `🔙 *Deposit Failed - Refund Processed*\n\n` +
              `We couldn’t process your ${amount} ${asset} deposit (Tx: \`${transactionHash}\`).\n` +
              `We’ve refunded it to \`${userState.refundAddress || wallet.address}\`.\n` +
              `• Ref ID: ${referenceId}\n` +
              `Contact [@maxcswap](https://t.me/maxcswap) for assistance!`;
          await bot.telegram.sendPhoto(userId, { source: ERROR_IMAGE }, {
            caption: refundMsg,
            parse_mode: 'Markdown'
          });

          await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🚨 Deposit failed and refunded for user ${userId}:\n` +
            `• Ref ID: ${referenceId}\n` +
            `• Amount: ${amount} ${asset}\n` +
            `• Refund Address: ${userState.refundAddress || wallet.address}\n` +
            `• Error: ${paycrestError.message}`, { parse_mode: 'Markdown' });
        } catch (refundError) {
          logger.error(`Blockradar webhook: Refund failed for ${referenceId}: ${refundError.message}`);
          const errorMsg = userState.usePidgin
            ? `❌ Deposit and refund fail for ${amount} ${asset} (Tx: \`${transactionHash}\`).\n` +
              `• Ref ID: ${referenceId}\n` +
              `Contact [@maxcswap](https://t.me/maxcswap) sharp sharp!`
            : `❌ Both deposit and refund failed for ${amount} ${asset} (Tx: \`${transactionHash}\`).\n` +
              `• Ref ID: ${referenceId}\n` +
              `Please contact [@maxcswap](https://t.me/maxcswap) immediately!`;
          await bot.telegram.sendPhoto(userId, { source: ERROR_IMAGE }, {
            caption: errorMsg,
            parse_mode: 'Markdown'
          });

          await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🚨 Critical: Deposit and refund failed for user ${userId}:\n` +
            `• Ref ID: ${referenceId}\n` +
            `• Amount: ${amount} ${asset}\n` +
            `• Error: ${paycrestError.message}\n` +
            `• Refund Error: ${refundError.message}`, { parse_mode: 'Markdown' });
        }
      }
    } else {
      logger.warn(`Blockradar webhook: Unhandled event type ${event}`);
      return res.status(400).json({ error: `Unhandled event type: ${event}` });
    }

    return res.status(200).json({ status: 'success' });
  } catch (error) {
    logger.error(`Blockradar webhook error: ${error.message}`);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/ =================== Server Startup ===================
app.listen(PORT, () => {
  logger.info(Server running on port ${PORT});
  bot.telegram.getMe().then((botInfo) => {
    logger.info(Bot ${botInfo.username} started successfully);
    bot.telegram.sendMessage(PERSONAL_CHAT_ID,  Bot ${botInfo.username} don start on port ${PORT}!, { parse_mode: 'Markdown' })
      .catch((err) => logger.error(Failed to send startup message: ${err.message}));
  }).catch((err) => logger.error(Error getting bot info: ${err.message}));
});

// =================== Error Handling ===================
process.on('unhandledRejection', (reason, promise) => {
  logger.error(Unhandled Rejection at: ${promise}, reason: ${reason});
});
process.on('uncaughtException', (error) => {
  logger.error(Uncaught Exception: ${error.stack});
  bot.telegram.sendMessage(PERSONAL_CHAT_ID,  Bot crash: ${error.message}, { parse_mode: 'Markdown' })
    .catch((err) => logger.error(Failed to send crash notification: ${err.message}));
});

module.exports = app;

