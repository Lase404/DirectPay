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
  RELAY_API_KEY,
  MAX_WALLETS = 5,
} = process.env;

if (!TELEGRAM_BOT_TOKEN || !PAYCREST_API_KEY || !PAYCREST_CLIENT_SECRET || !WEBHOOK_DOMAIN || !PAYSTACK_API_KEY || !BLOCKRADAR_SOLANA_API_KEY || !RELAY_API_KEY) {
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
    explorer: 'https://basescan.org/tx/',
    relayChainId: 8453,
    usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
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
    explorer: 'https://solscan.io/tx/',
    relayChainId: 792703809,
    usdcAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    usdtAddress: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
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

async function createRelayQuote(userId, amount, asset, userSolanaAddress, paycrestReceiveAddress) {
  try {
    const chainData = chains['Solana'];
    const assetAddress = asset === 'USDC' ? chainData.usdcAddress : chainData.usdtAddress;
    const amountInWei = (amount * 1e6).toString(); // 6 decimals for USDC/USDT

    const quotePayload = {
      user: "master_wallet",
      originChainId: chainData.relayChainId,
      originCurrency: assetAddress,
      destinationChainId: chains['Base'].relayChainId,
      destinationCurrency: chains['Base'].usdcAddress,
      tradeType: "EXACT_INPUT",
      recipient: paycrestReceiveAddress,
      amount: amountInWei,
      usePermit: false,
      useExternalLiquidity: false,
      referrer: "relay.link/bridge",
      useDepositAddress: true,
      refundTo: userSolanaAddress
    };

    const response = await axios.post('https://api.relay.link/quote', quotePayload, {
      headers: {
        'Authorization': `Bearer ${RELAY_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.data.steps || !response.data.steps[0].depositAddress) {
      throw new Error('Invalid Relay quote response: Missing depositAddress');
    }

    return {
      depositAddress: response.data.steps[0].depositAddress,
      requestId: response.data.steps[0].requestId,
      fees: response.data.fees,
      estimatedOutput: response.data.details.currencyOut.amountFormatted
    };
  } catch (error) {
    logger.error(`Error creating Relay quote for user ${userId}: ${error.message}`);
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
        `📂 *Wallet ${walletIndex + 1} Details (Solana):*\n` +
        `• *Chain:* Solana\n` +
        `• *Address:* \`${solanaAddress}\`\n` +
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
        `📂 *Wallet ${walletIndex + 1} Details (Solana):*\n` +
        `• *Chain:* Solana\n` +
        `• *Address:* \`${solanaAddress}\`\n` +
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

// Receipt Generation Scene
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
                           `- *Chain:* ${tx.chain || 'N/A'}\n` +
                           (tx.relayRequestId ? `- *Relay Request ID:* \`${tx.relayRequestId}\`\n` : '') +
                           (tx.relayDepositAddress ? `- *Relay Deposit Address:* \`${tx.relayDepositAddress}\`\n` : '') +
                           `\n`;
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

receiptGenerationScene.action(/export_receipt_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);
  const userState = await getUserState(userId);

  try {
    const wallet = userState.wallets[walletIndex];
    if (!wallet) throw new Error('Wallet not found.');

    const transactionsSnapshot = await db.collection('transactions')
      .where('walletAddress', 'in', [wallet.address, wallet.solanaAddress])
      .orderBy('timestamp', 'desc')
      .limit(10)
      .get();

    let receiptText = `Transaction History - Wallet ${walletIndex + 1}${wallet.name ? ` (${wallet.name})` : ''} (${wallet.chain})\n\n`;
    if (transactionsSnapshot.empty) {
      receiptText += 'No transactions found for this wallet yet.\nSend USDC/USDT to your wallet address to begin.';
    } else {
      receiptText += 'Recent Transactions:\n\n';
      transactionsSnapshot.forEach((doc, index) => {
        const tx = doc.data();
        receiptText += `Transaction ${index + 1}\n` +
                       `- Ref ID: ${tx.referenceId || 'N/A'}\n` +
                       `- Amount: ${tx.amount || 'N/A'} ${tx.asset || 'N/A'}\n` +
                       `- Payout: ₦${tx.payoutAmount || 'N/A'}\n` +
                       `- Status: ${tx.status || 'Pending'}\n` +
                       `- Rate: ₦${exchangeRates[tx.asset] || 'N/A'} per ${tx.asset || 'N/A'}\n` +
                       `- Date: ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n` +
                       `- Chain: ${tx.chain || 'N/A'}\n` +
                       (tx.relayRequestId ? `- Relay Request ID: ${tx.relayRequestId}\n` : '') +
                       (tx.relayDepositAddress ? `- Relay Deposit Address: ${tx.relayDepositAddress}\n` : '') +
                       `\n`;
      });
    }

    const filePath = path.join(__dirname, `transaction_history_${userId}_${Date.now()}.txt`);
    await fs.promises.writeFile(filePath, receiptText);

    await ctx.replyWithDocument({ source: createReadStream(filePath) }, {
      caption: userState.usePidgin ? '📤 Your transaction history don export.' : '📤 Your transaction history has been exported.'
    });

    await unlinkAsync(filePath);
    logger.info(`Exported transaction history for user ${userId}, wallet ${walletIndex + 1}`);
  } catch (error) {
    logger.error(`Error exporting receipt for user ${userId}: ${error.message}`);
    const errorMsg = userState.usePidgin
      ? '❌ Error exporting transaction history. Try again later.'
      : '❌ Error exporting transaction history. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
  } finally {
    await ctx.answerCbQuery();
  }
});

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
app.post(WEBHOOK_BLOCKRADAR_PATH, bodyParser.json(), async (req, res) => {
  await handleBlockradarWebhook(req, res);
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

// Main Menu Command
bot.command(['start', 'menu'], async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  // Initialize user state if first interaction
  if (!userState.firstName) {
    userState.firstName = ctx.from.first_name || 'User';
    await updateUserState(userId, { firstName: userState.firstName });
  }

  const greeting = userState.usePidgin
    ? `👋 Welcome,${userState.firstName}! Wetin you wan do today?`
    : `👋 Welcome, ${userState.firstName}! What would you like to do today?`;

  const keyboard = [
    [Markup.button.callback('💼 Generate Wallet', 'generate_wallet')],
    [Markup.button.callback('🧾 Transaction History', 'transaction_history')],
    [Markup.button.callback('⚙️ Settings', 'settings')],
  ];

  if (ADMIN_IDS.split(',').includes(userId)) {
    keyboard.push([Markup.button.callback('📩 Send Message to User', 'send_message')]);
  }

  await ctx.replyWithMarkdown(greeting, Markup.inlineKeyboard(keyboard));
});

// Action Handlers
bot.action('generate_wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  if (userState.wallets.length >= parseInt(MAX_WALLETS, 10)) {
    const errorMsg = userState.usePidgin
      ? `❌ You don reach max wallet limit (${MAX_WALLETS}). Contact [@maxcswap](https://t.me/maxcswap) for more.'
      : `❌ You have reached the maximum wallet limit (${MAX_WALLETS}). Contact [@maxcswap](https://t.me/maxcswap) for assistance.`;
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
    return;
  }

  try {
    const evmAddress = await generateWallet('Base');
    const solanaAddress = await generateWallet('Solana');
    const evmQrPath = path.join(__dirname, `temp_evm_qr_${userId}_${Date.now()}.png`);
    const solanaQrPath = path.join(__dirname, `temp_solana_qr_${userId}_${Date.now()}.png`);

    userState.wallets.push({
      address: evmAddress,
      solanaAddress: solanaAddress,
      chain: 'Base/Solana',
      evmQrPath,
      solanaQrPath,
      bank: null,
      name: null,
    });
    userState.walletAddresses.push(evmAddress, solanaAddress);

    await updateUserState(userId, {
      wallets: userState.wallets,
      walletAddresses: userState.walletAddresses,
    });

    await generateQRCodeImage(evmAddress, WALLET_GENERATED_IMAGE, evmQrPath);
    await generateQRCodeImage(solanaAddress, WALLET_GENERATED_IMAGE, solanaQrPath);
    await cleanupOldQrCodes(userId, [evmQrPath, solanaQrPath]);

    const walletIndex = userState.wallets.length - 1;
    ctx.session.bankLinking = { walletIndex };

    const message = userState.usePidgin
      ? `📂 *New Wallet Generated (Wallet ${walletIndex + 1})*\n\n` +
        `• *Chain (EVM):* Base\n` +
        `• *Address:* \`${evmAddress}\`\n` +
        `• *Supported Assets:* USDC, USDT\n\n` +
        `• *Chain (Solana):* Solana\n` +
        `• *Address:* \`${solanaAddress}\`\n` +
        `• *Supported Assets:* USDC, USDT\n\n` +
        `Link bank account to receive payouts.`
      : `📂 *New Wallet Generated (Wallet ${walletIndex + 1})*\n\n` +
        `• *Chain (EVM):* Base\n` +
        `• *Address:* \`${evmAddress}\`\n` +
        `• *Supported Assets:* USDC, USDT\n\n` +
        `• *Chain (Solana):* Solana\n` +
        `• *Address:* \`${solanaAddress}\`\n` +
        `• *Supported Assets:* USDC, USDT\n\n` +
        `Please link a bank account to receive payouts.`;

    const navigationButtons = [];
    navigationButtons.push([Markup.button.callback('🔄 Show Solana Wallet', `show_solana_wallet_${walletIndex}`)]);
    if (userState.wallets.length > 1) {
      navigationButtons.push([
        Markup.button.callback('⬅️ Previous Wallet', `prev_wallet_${walletIndex}`),
        Markup.button.callback('➡️ Next Wallet', `next_wallet_${walletIndex}`),
      ]);
    }
    navigationButtons.push([Markup.button.callback('🏦 Link Bank Account', `link_bank_${walletIndex}`)]);
    navigationButtons.push([Markup.button.callback('🏠 Main Menu', 'back_to_main')]);

    await ctx.replyWithPhoto(
      { source: createReadStream(evmQrPath) },
      {
        caption: message,
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard(navigationButtons),
      }
    );

    logger.info(`Generated wallet for user ${userId}: EVM=${evmAddress}, Solana=${solanaAddress}`);
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error generating wallet for user ${userId}: ${error.message}`);
    const errorMsg = userState.usePidgin
      ? '❌ Error generating wallet. Try again or contact [@maxcswap](https://t.me/maxcswap).'
      : '❌ Failed to generate wallet. Try again or contact [@maxcswap](https://t.me/maxcswap).';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
  }
});

bot.action(/link_bank_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);
  const userState = await getUserState(userId);

  if (!userState.wallets[walletIndex]) {
    const errorMsg = userState.usePidgin
      ? '❌ Wallet no dey. Try again.'
      : '❌ Invalid wallet. Please try again.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
    return;
  }

  ctx.session.bankLinking = { walletIndex };
  await ctx.answerCbQuery();
  await ctx.scene.enter('bank_linking_scene');
});

bot.action('transaction_history', async (ctx) => {
  const userId = ctx.from.id.toString();
  await ctx.answerCbQuery();
  await ctx.scene.enter('receipt_generation_scene');
});

bot.action('settings', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  const settingsMessage = userState.usePidgin
    ? `⚙️ *Settings*\n\n` +
      `• *Language:* ${userState.usePidgin ? 'Pidgin' : 'English'}\n` +
      `• *Refund Address:* ${userState.refundAddress || 'Not set (uses wallet address)'}\n\n` +
      `Wetin you wan change?`
    : `⚙️ *Settings*\n\n` +
      `• *Language:* ${userState.usePidgin ? 'Pidgin' : 'English'}\n` +
      `• *Refund Address:* ${userState.refundAddress || 'Not set (uses wallet address)'}\n\n` +
      `What would you like to change?`;

  const keyboard = [
    [Markup.button.callback('🌐 Change Language', 'change_language')],
    [Markup.button.callback('🔄 Set Refund Address', 'set_refund_address')],
    [Markup.button.callback('🏠 Main Menu', 'back_to_main')],
  ];

  await ctx.replyWithMarkdown(settingsMessage, Markup.inlineKeyboard(keyboard));
  await ctx.answerCbQuery();
});

bot.action('change_language', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  const newLanguage = !userState.usePidgin;
  await updateUserState(userId, { usePidgin: newLanguage });

  const successMsg = newLanguage
    ? '✅ Language don change to Pidgin.'
    : '✅ Language changed to English.';
  await ctx.replyWithMarkdown(successMsg);

  const settingsMessage = newLanguage
    ? `⚙️ *Settings*\n\n` +
      `• *Language:* Pidgin\n` +
      `• *Refund Address:* ${userState.refundAddress || 'Not set (uses wallet address)'}\n\n` +
      `Wetin you wan change?`
    : `⚙️ *Settings*\n\n` +
      `• *Language:* English\n` +
      `• *Refund Address:* ${userState.refundAddress || 'Not set (uses wallet address)'}\n\n` +
      `What would you like to change?`;

  const keyboard = [
    [Markup.button.callback('🌐 Change Language', 'change_language')],
    [Markup.button.callback('🔄 Set Refund Address', 'set_refund_address')],
    [Markup.button.callback('🏠 Main Menu', 'back_to_main')],
  ];

  await ctx.replyWithMarkdown(settingsMessage, Markup.inlineKeyboard(keyboard));
  await ctx.answerCbQuery();
});

bot.action('set_refund_address', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  const prompt = userState.usePidgin
    ? '🔄 Enter new refund address (EVM or Solana) or "clear" to remove:'
    : '🔄 Please enter a new refund address (EVM or Solana) or type "clear" to remove:';
  await ctx.replyWithMarkdown(prompt);

  ctx.session.awaitingRefundAddress = true;
  await ctx.answerCbQuery();
});

bot.action('send_message', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!ADMIN_IDS.split(',').includes(userId)) {
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ You no be admin. Access denied.'
      : '❌ You are not an admin. Access denied.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
    return;
  }

  await ctx.answerCbQuery();
  await ctx.scene.enter('send_message_scene');
});

bot.action('back_to_main', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  const greeting = userState.usePidgin
    ? `👋 Welcome back, ${userState.firstName}! Wetin you wan do now?`
    : `👋 Welcome back, ${userState.firstName}! What would you like to do now?`;

  const keyboard = [
    [Markup.button.callback('💼 Generate Wallet', 'generate_wallet')],
    [Markup.button.callback('🧾 Transaction History', 'transaction_history')],
    [Markup.button.callback('⚙️ Settings', 'settings')],
  ];

  if (ADMIN_IDS.split(',').includes(userId)) {
    keyboard.push([Markup.button.callback('📩 Send Message to User', 'send_message')]);
  }

  await ctx.replyWithMarkdown(greeting, Markup.inlineKeyboard(keyboard));
  await ctx.answerCbQuery();
});

// Handle Text Input for Refund Address
bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  if (ctx.session.awaitingRefundAddress) {
    const input = ctx.message.text.trim();
    let refundAddress = null;

    if (input.toLowerCase() === 'clear') {
      await updateUserState(userId, { refundAddress: null });
      const successMsg = userState.usePidgin
        ? '✅ Refund address don clear.'
        : '✅ Refund address cleared.';
      await ctx.replyWithMarkdown(successMsg);
    } else {
      // Validate EVM or Solana address
      const isEvmAddress = ethers.utils.isAddress(input);
      const isSolanaAddress = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(input); // Basic Solana address regex

      if (isEvmAddress || isSolanaAddress) {
        refundAddress = input;
        await updateUserState(userId, { refundAddress });
        const successMsg = userState.usePidgin
          ? `✅ Refund address set to: \`${refundAddress}\`.`
          : `✅ Refund address set to: \`${refundAddress}\`.`;
        await ctx.replyWithMarkdown(successMsg);
      } else {
        const errorMsg = userState.usePidgin
          ? '❌ Invalid address. Use valid EVM or Solana address, or "clear" to remove.'
          : '❌ Invalid address. Please provide a valid EVM or Solana address, or type "clear" to remove.';
        await ctx.replyWithMarkdown(errorMsg);
        return;
      }
    }

    const settingsMessage = userState.usePidgin
      ? `⚙️ *Settings*\n\n` +
        `• *Language:* ${userState.usePidgin ? 'Pidgin' : 'English'}\n` +
        `• *Refund Address:* ${refundAddress || 'Not set (uses wallet address)'}\n\n` +
        `Wetin you wan change?`
      : `⚙️ *Settings*\n\n` +
        `• *Language:* ${userState.usePidgin ? 'Pidgin' : 'English'}\n` +
        `• *Refund Address:* ${refundAddress || 'Not set (uses wallet address)'}\n\n` +
        `What would you like to change?`;

    const keyboard = [
      [Markup.button.callback('🌐 Change Language', 'change_language')],
      [Markup.button.callback('🔄 Set Refund Address', 'set_refund_address')],
      [Markup.button.callback('🏠 Main Menu', 'back_to_main')],
    ];

    await ctx.replyWithMarkdown(settingsMessage, Markup.inlineKeyboard(keyboard));
    delete ctx.session.awaitingRefundAddress;
  }
});

// Webhook Handlers
async function handlePaycrestWebhook(req, res) {
  const userId = 'webhook';
  const signature = req.headers['x-paycrest-signature'];
  if (!signature) {
    logger.error('Paycrest webhook: Missing signature');
    return res.status(401).send('Missing signature');
  }

  const rawBody = req.body.toString();
  if (!verifyPaycrestSignature(rawBody, signature, PAYCREST_CLIENT_SECRET)) {
    logger.error('Paycrest webhook: Invalid signature');
    return res.status(401).send('Invalid signature');
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (error) {
    logger.error(`Paycrest webhook: Invalid JSON - ${error.message}`);
    return res.status(400).send('Invalid JSON');
  }

  const { event, data } = payload;
  if (!event || !data) {
    logger.error('Paycrest webhook: Missing event or data');
    return res.status(400).send('Missing event or data');
  }

  try {
    const transactionRef = data.reference || data.orderId;
    const transactionDocRef = db.collection('transactions').doc(transactionRef);
    const transactionDoc = await transactionDocRef.get();

    if (!transactionDoc.exists) {
      logger.warn(`Paycrest webhook: Transaction ${transactionRef} not found`);
      return res.status(404).send('Transaction not found');
    }

    const transaction = transactionDoc.data();
    const userId = transaction.userId;
    const userState = await getUserState(userId);

    if (event === 'order.completed') {
      await transactionDocRef.update({
        status: 'Completed',
        payoutAmount: data.fiatAmount,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      const successMsg = userState.usePidgin
        ? `✅ *Payout Successful*\n\n` +
          `• *Ref ID:* \`${transactionRef}\`\n` +
          `• *Amount:* ${transaction.amount} ${transaction.asset}\n` +
          `• *Payout:* ₦${data.fiatAmount}\n` +
          `• *Bank:* ${transaction.bankName} (****${transaction.accountNumber.slice(-4)})\n` +
          `• *Date:* ${new Date().toLocaleString()}\n\n` +
          `Check your bank account!`
        : `✅ *Payout Successful*\n\n` +
          `• *Ref ID:* \`${transactionRef}\`\n` +
          `• *Amount:* ${transaction.amount} ${transaction.asset}\n` +
          `• *Payout:* ₦${data.fiatAmount}\n` +
          `• *Bank:* ${transaction.bankName} (****${transaction.accountNumber.slice(-4)})\n` +
          `• *Date:* ${new Date().toLocaleString()}\n\n` +
          `Please check your bank account!`;

      await bot.telegram.sendPhoto(userId, { source: PAYOUT_SUCCESS_IMAGE }, {
        caption: successMsg,
        parse_mode: 'Markdown',
      });

      await bot.telegram.sendMessage(
        PERSONAL_CHAT_ID,
        `🎉 Payout completed for user ${userId}:\n\n` +
          `*Ref ID:* \`${transactionRef}\`\n` +
          `*Amount:* ${transaction.amount} ${transaction.asset}\n` +
          `*Payout:* ₦${data.fiatAmount}\n` +
          `*Bank:* ${transaction.bankName} (****${transaction.accountNumber.slice(-4)})`,
        { parse_mode: 'Markdown' }
      );

      logger.info(`Paycrest webhook: Payout completed for transaction ${transactionRef}`);
    } else if (event === 'order.failed') {
      await transactionDocRef.update({
        status: 'Failed',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      const refundAddress = userState.refundAddress || transaction.walletAddress;
      let refundInitiated = false;
      let refundTxHash = null;

      try {
        const chainData = chains[transaction.chain] || chains['Base'];
        const assetId = chainData.assets[transaction.asset];
        const withdrawal = await withdrawFromBlockradar(
          transaction.chain,
          assetId,
          refundAddress,
          transaction.amount,
          transactionRef,
          { userId, reason: 'Payout failed' }
        );

        refundTxHash = withdrawal.data.transactionHash;
        refundInitiated = true;
        await transactionDocRef.update({
          refundTxHash,
          refundAddress,
          status: 'Refunded',
        });
      } catch (refundError) {
        logger.error(`Paycrest webhook: Refund failed for ${transactionRef}: ${refundError.message}`);
      }

      const errorMsg = userState.usePidgin
        ? `❌ *Payout Failed*\n\n` +
          `• *Ref ID:* \`${transactionRef}\`\n` +
          `• *Amount:* ${transaction.amount} ${transaction.asset}\n` +
          `• *Reason:* ${data.reason || 'Unknown'}\n\n` +
          (refundInitiated
            ? `We don send *${transaction.amount} ${transaction.asset}* back to \`${refundAddress}\`.\n` +
              `• *Refund Tx:* [View on Explorer](${chainData.explorer}${refundTxHash})\n\n` +
              `Check your wallet.`
            : `We no fit refund automatically. Contact [@maxcswap](https://t.me/maxcswap) with Ref ID.`)
        : `❌ *Payout Failed*\n\n` +
          `• *Ref ID:* \`${transactionRef}\`\n` +
          `• *Amount:* ${transaction.amount} ${transaction.asset}\n` +
          `• *Reason:* ${data.reason || 'Unknown'}\n\n` +
          (refundInitiated
            ? `We have refunded *${transaction.amount} ${transaction.asset}* to \`${refundAddress}\`.\n` +
              `• *Refund Tx:* [View on Explorer](${chainData.explorer}${refundTxHash})\n\n` +
              `Please check your wallet.`
            : `Automatic refund failed. Please contact [@maxcswap](https://t.me/maxcswap) with the Ref ID.`);

      await bot.telegram.sendPhoto(userId, { source: ERROR_IMAGE }, {
        caption: errorMsg,
        parse_mode: 'Markdown',
      });

      await bot.telegram.sendMessage(
        PERSONAL_CHAT_ID,
        `🚨 Payout failed for user ${userId}:\n\n` +
          `*Ref ID:* \`${transactionRef}\`\n` +
          `*Amount:* ${transaction.amount} ${transaction.asset}\n` +
          `*Reason:* ${data.reason || 'Unknown'}\n` +
          (refundInitiated
            ? `*Refund Sent:* ${transaction.amount} ${transaction.asset} to \`${refundAddress}\`\n` +
              `*Refund Tx:* ${refundTxHash}`
            : `*Refund Status:* Failed`),
        { parse_mode: 'Markdown' }
      );

      logger.info(`Paycrest webhook: Payout failed for transaction ${transactionRef}, refund ${refundInitiated ? 'initiated' : 'failed'}`);
    } else {
      logger.warn(`Paycrest webhook: Unhandled event type ${event}`);
      return res.status(200).send('Unhandled event');
    }

    return res.status(200).send('Webhook processed');
  } catch (error) {
    logger.error(`Paycrest webhook error: ${error.message}`);
    await bot.telegram.sendMessage(
      PERSONAL_CHAT_ID,
      `🚨 Paycrest webhook error: ${error.message}\n\nEvent: ${event}\nTransaction: ${JSON.stringify(data)}`,
      { parse_mode: 'Markdown' }
    );
    return res.status(500).send('Internal server error');
  }
}

async function handleBlockradarWebhook(req, res) {
  const userId = 'webhook';
  const payload = req.body;

  if (!payload || !payload.type || !payload.data) {
    logger.error('Blockradar webhook: Invalid payload');
    return res.status(400).send('Invalid payload');
  }

  const { type, data } = payload;

  try {
    if (type === 'deposit.confirmed') {
      const { walletId, address, amount, assetId, transactionHash, network } = data;
      const chainKey = Object.keys(chains).find(
        (key) => chains[key].id === walletId && chains[key].network.toLowerCase() === network.toLowerCase()
      );

      if (!chainKey) {
        logger.error(`Blockradar webhook: Unknown walletId ${walletId} or network ${network}`);
        return res.status(400).send('Unknown wallet or network');
      }

      const chainData = chains[chainKey];
      const asset = Object.keys(chainData.assets).find(
        (key) => chainData.assets[key] === assetId
      );

      if (!asset || !SUPPORTED_ASSETS.includes(asset)) {
        logger.error(`Blockradar webhook: Unsupported assetId ${assetId}`);
        return res.status(400).send('Unsupported asset');
      }

      const userDoc = await db.collection('users')
        .where('walletAddresses', 'array-contains', address)
        .limit(1)
        .get();

      if (userDoc.empty) {
        logger.warn(`Blockradar webhook: No user found for address ${address}`);
        return res.status(404).send('User not found');
      }

      const user = userDoc.docs[0].data();
      const userId = userDoc.docs[0].id;
      const userState = await getUserState(userId);
      const wallet = userState.wallets.find(
        (w) => w.address === address || w.solanaAddress === address
      );

      if (!wallet || !wallet.bank) {
        const errorMsg = userState.usePidgin
          ? `❌ Deposit detected but no bank linked for wallet \`${address}\`.\n\n` +
            `• *Amount:* ${amount} ${asset}\n` +
            `• *Tx Hash:* [View on Explorer](${chainData.explorer}${transactionHash})\n\n` +
            `Link bank account to receive payouts or contact [@maxcswap](https://t.me/maxcswap).`
          : `❌ Deposit detected but no bank account linked for wallet \`${address}\`.\n\n` +
            `• *Amount:* ${amount} ${asset}\n` +
            `• *Tx Hash:* [View on Explorer](${chainData.explorer}${transactionHash})\n\n` +
            `Please link a bank account to receive payouts or contact [@maxcswap](https://t.me/maxcswap).`;

        await bot.telegram.sendPhoto(userId, { source: ERROR_IMAGE }, {
          caption: errorMsg,
          parse_mode: 'Markdown',
        });

        await bot.telegram.sendMessage(
          PERSONAL_CHAT_ID,
          `🚨 Deposit without bank for user ${userId}:\n\n` +
            `*Address:* \`${address}\`\n` +
            `*Amount:* ${amount} ${asset}\n` +
            `*Chain:* ${chainKey}\n` +
            `*Tx Hash:* ${transactionHash}`,
          { parse_mode: 'Markdown' }
        );

        return res.status(200).send('No bank linked');
      }

      const referenceId = generateReferenceId();
      const payoutAmount = calculatePayout(asset, amount);
      let paycrestOrder = null;
      let relayData = null;

      if (chainKey === 'Solana') {
        try {
          relayData = await createRelayQuote(
            userId,
            amount,
            asset,
            wallet.solanaAddress,
            PAYCREST_RETURN_ADDRESS
          );

          paycrestOrder = await createPaycrestOrder(
            userId,
            amount,
            asset,
            'Base', // Solana deposits are bridged to Base
            wallet.bank,
            relayData.depositAddress
          );
        } catch (relayError) {
          logger.error(`Blockradar webhook: Relay quote or Paycrest order failed for ${referenceId}: ${relayError.message}`);
          const errorMsg = userState.usePidgin
            ? `❌ Deposit detected but we no fit process am.\n\n` +
              `• *Amount:* ${amount} ${asset}\n` +
              `• *Tx Hash:* [View on Explorer](${chainData.explorer}${transactionHash})\n\n` +
              `Contact [@maxcswap](https://t.me/maxcswap) with Ref ID: \`${referenceId}\`.`
            : `❌ Deposit detected but we couldn't process it.\n\n` +
              `• *Amount:* ${amount} ${asset}\n` +
              `• *Tx Hash:* [View on Explorer](${chainData.explorer}${transactionHash})\n\n` +
              `Please contact [@maxcswap](https://t.me/maxcswap) with Ref ID: \`${referenceId}\`.`;

          await bot.telegram.sendPhoto(userId, { source: ERROR_IMAGE }, {
            caption: errorMsg,
            parse_mode: 'Markdown',
          });

          await bot.telegram.sendMessage(
            PERSONAL_CHAT_ID,
            `🚨 Deposit processing failed for user ${userId}:\n\n` +
              `*Address:* \`${address}\`\n` +
              `*Amount:* ${amount} ${asset}\n` +
              `*Chain:* ${chainKey}\n` +
              `*Tx Hash:* ${transactionHash}\n` +
              `*Error:* ${relayError.message}`,
            { parse_mode: 'Markdown' }
          );

          return res.status(200).send('Processing failed');
        }
      } else {
        paycrestOrder = await createPaycrestOrder(
          userId,
          amount,
          asset,
          chainKey,
          wallet.bank,
          wallet.address
        );
      }

      await db.collection('transactions').doc(referenceId).set({
        userId,
        walletAddress: address,
        amount,
        asset,
        payoutAmount,
        bankName: wallet.bank.bankName,
        accountNumber: wallet.bank.accountNumber,
        status: 'Pending',
        referenceId,
        transactionHash,
        chain: chainKey,
        relayRequestId: relayData?.requestId || null,
        relayDepositAddress: relayData?.depositAddress || null,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });

      const depositMsg = userState.usePidgin
        ? `✅ *Deposit Confirmed*\n\n` +
          `• *Ref ID:* \`${referenceId}\`\n` +
          `• *Amount:* ${amount} ${asset}\n` +
          `• *Payout:* ₦${payoutAmount}\n` +
          `• *Bank:* ${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)})\n` +
          `• *Chain:* ${chainKey}\n` +
          `• *Tx Hash:* [View on Explorer](${chainData.explorer}${transactionHash})\n` +
          (relayData
            ? `• *Relay Deposit Address:* \`${relayData.depositAddress}\`\n` +
              `• *Relay Request ID:* \`${relayData.requestId}\`\n`
            : '') +
          `\nWe don start processing your payout. We go notify you when e complete.`
        : `✅ *Deposit Confirmed*\n\n` +
          `• *Ref ID:* \`${referenceId}\`\n` +
          `• *Amount:* ${amount} ${asset}\n` +
          `• *Payout:* ₦${payoutAmount}\n` +
          `• *Bank:* ${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)})\n` +
          `• *Chain:* ${chainKey}\n` +
          `• *Tx Hash:* [View on Explorer](${chainData.explorer}${transactionHash})\n` +
          (relayData
            ? `• *Relay Deposit Address:* \`${relayData.depositAddress}\`\n` +
              `• *Relay Request ID:* \`${relayData.requestId}\`\n`
            : '') +
          `\nWe are processing your payout. You'll be notified upon completion.`;

      await bot.telegram.sendPhoto(userId, { source: DEPOSIT_SUCCESS_IMAGE }, {
        caption: depositMsg,
        parse_mode: 'Markdown',
      });

      await bot.telegram.sendMessage(
        PERSONAL_CHAT_ID,
        `💸 New deposit for user ${userId}:\n\n` +
          `*Ref ID:* \`${referenceId}\`\n` +
          `*Address:* \`${address}\`\n` +
          `*Amount:* ${amount} ${asset}\n` +
          `*Payout:* ₦${payoutAmount}\n` +
          `*Bank:* ${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)})\n` +
          `*Chain:* ${chainKey}\n` +
          `*Tx Hash:* ${transactionHash}\n` +
          (relayData
            ? `*Relay Deposit:* \`${relayData.depositAddress}\`\n` +
              `*Relay Request ID:* \`${relayData.requestId}\``
            : ''),
        { parse_mode: 'Markdown' }
      );

      if (!userState.hasReceivedDeposit) {
        await updateUserState(userId, { hasReceivedDeposit: true });
      }

      logger.info(`Blockradar webhook: Deposit confirmed for user ${userId}, Ref ID: ${referenceId}`);
      return res.status(200).send('Deposit processed');
    } else {
      logger.warn(`Blockradar webhook: Unhandled event type ${type}`);
      return res.status(200).send('Unhandled event');
    }
  } catch (error) {
    logger.error(`Blockradar webhook error: ${error.message}`);
    await bot.telegram.sendMessage(
      PERSONAL_CHAT_ID,
      `🚨 Blockradar webhook error: ${error.message}\n\nType: ${type}\nData: ${JSON.stringify(data)}`,
      { parse_mode: 'Markdown' }
    );
    return res.status(500).send('Internal server error');
  }
}

// Fetch Exchange Rates
async function fetchExchangeRates() {
  try {
    const response = await axios.get(PAYCREST_RATE_API_URL, {
      headers: { 'API-Key': PAYCREST_API_KEY },
    });

    if (response.data.status !== 'success') {
      throw new Error('Failed to fetch rates from Paycrest');
    }

    const rates = response.data.data;
    const newRates = {};

    SUPPORTED_ASSETS.forEach((asset) => {
      const rate = rates.find(
        (r) => r.token === asset && r.network === 'base'
      );
      if (rate && rate.rate) {
        newRates[asset] = parseFloat(rate.rate);
      } else {
        logger.warn(`No rate found for ${asset} on Base`);
      }
    });

    if (Object.keys(newRates).length > 0) {
      exchangeRates = { ...exchangeRates, ...newRates };
      logger.info(`Updated exchange rates: ${JSON.stringify(exchangeRates)}`);
    } else {
      logger.warn('No new rates to update');
    }
  } catch (error) {
    logger.error(`Error fetching exchange rates: ${error.message}`);
    throw error;
  }
}

// Periodic Exchange Rate Update
setInterval(async () => {
  try {
    await fetchExchangeRates();
    logger.info('Periodic exchange rate update successful');
  } catch (error) {
    logger.error(`Periodic exchange rate update failed: ${error.message}`);
    await bot.telegram.sendMessage(
      PERSONAL_CHAT_ID,
      `🚨 Exchange rate update failed: ${error.message}`,
      { parse_mode: 'Markdown' }
    );
  }
}, 15 * 60 * 1000); // Every 15 minutes

// Start Express Server
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});

// Error Handling
bot.catch(async (err, ctx) => {
  const userId = ctx.from?.id?.toString() || 'unknown';
  logger.error(`Bot error for user ${userId}: ${err.message}`);
  const userState = await getUserState(userId);
  const errorMsg = userState.usePidgin
    ? '❌ Something no work. Try again or contact [@maxcswap](https://t.me/maxcswap).'
    : '❌ An error occurred. Please try again or contact [@maxcswap](https://t.me/maxcswap).';
  await ctx.replyWithMarkdown(errorMsg);
  await bot.telegram.sendMessage(
    PERSONAL_CHAT_ID,
    `🚨 Bot error for user ${userId}:\n\n${err.message}\n\nContext: ${JSON.stringify(ctx.update)}`,
    { parse_mode: 'Markdown' }
  );
});

// Graceful Shutdown
process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM. Shutting down...');
  await bot.telegram.sendMessage(
    PERSONAL_CHAT_ID,
    '🛑 Bot is shutting down for maintenance.',
    { parse_mode: 'Markdown' }
  );
  await bot.stop();
  process.exit(0);
});
