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
const cron = require('cron');
const DEPOSIT_SUCCESS_IMAGE = path.join(__dirname, 'assets', 'deposit_success.png');
const PAYOUT_SUCCESS_IMAGE = path.join(__dirname, 'assets', 'payout_success.png');
const WALLET_GENERATED_IMAGE = path.join(__dirname, 'assets', 'wallet_generated_base1.png');


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
  if (!chainKey) return null;
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
    throw new Error('Failed to verify bank account.');
  }
}

async function createPaycrestOrder(userId, amount, token, network, recipientDetails, userSendAddress) {
  try {
    const paycrestMapping = mapToPaycrest(token, network);
    if (!paycrestMapping) throw new Error('No Paycrest mapping for the selected asset/chain.');

    const bank = bankList.find(b => b.name.toLowerCase() === recipientDetails.bankName.toLowerCase());
    if (!bank || !bank.paycrestInstitutionCode) throw new Error(`No Paycrest institution code for bank: ${recipientDetails.bankName}`);

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

async function fetchPaycrestOrder(orderId) {
  try {
    const resp = await axios.get(`https://api.paycrest.io/v1/sender/orders/${orderId}`, {
      headers: { 'API-Key': PAYCREST_API_KEY }
    });
    if (resp.data.status !== 'success') throw new Error(`Failed to fetch Paycrest order: ${resp.data.message}`);
    return resp.data.data;
  } catch (error) {
    logger.error(`Error fetching Paycrest order ${orderId}: ${error.message}`);
    throw error;
  }
}

async function getWalletBalance(walletId, assetId, chainKey) {
  try {
    const chainData = chains[chainKey];
    const resp = await axios.get(`https://api.blockradar.co/v1/wallets/${walletId}/balance`, {
      headers: { 'x-api-key': chainData.key },
      params: { assetId }
    });
    if (resp.data.statusCode !== 200) throw new Error(`Failed to fetch balance: ${resp.data.message}`);
    return resp.data.data;
  } catch (error) {
    logger.error(`Error fetching balance for wallet ${walletId}, asset ${assetId}: ${error.message}`);
    throw error;
  }
}

async function rescanBlocks(walletId, transactionHash, chainKey) {
  try {
    const chainData = chains[chainKey];
    const resp = await axios.post(`https://api.blockradar.co/v1/wallets/${walletId}/rescan/blocks`, 
      { transactionHash },
      { headers: { 'x-api-key': chainData.key, 'Content-Type': 'application/json' } }
    );
    if (resp.data.statusCode !== 200) throw new Error(`Failed to rescan blocks: ${resp.data.message}`);
    return resp.data;
  } catch (error) {
    logger.error(`Error rescanning blocks for wallet ${walletId}, tx ${transactionHash}: ${error.message}`);
    throw error;
  }
}

async function calculateWithdrawFee(walletId, addressId, assetId, address, amount, chainKey) {
  try {
    const chainData = chains[chainKey];
    const resp = await axios.post(`https://api.blockradar.co/v1/wallets/${walletId}/addresses/${addressId}/withdraw/network-fee`, 
      { assetId, address, amount },
      { headers: { 'x-api-key': chainData.key, 'Content-Type': 'application/json' } }
    );
    if (resp.data.statusCode !== 200) throw new Error(`Failed to calculate withdraw fee: ${resp.data.message}`);
    return resp.data.data.networkFee;
  } catch (error) {
    logger.error(`Error calculating withdraw fee for wallet ${walletId}, address ${addressId}: ${error.message}`);
    throw error;
  }
}

async function withdrawFromBlockradar(chain, assetId, address, amount, reference, metadata) {
  try {
    const chainKey = chainMapping[chain.toLowerCase()];
    if (!chainKey) throw new Error(`Unsupported chain: ${chain}`);

    const chainData = chains[chainKey];
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
    if (resp.data.statusCode !== 200) throw new Error(`Blockradar withdrawal error: ${JSON.stringify(resp.data)}`);
    return resp.data;
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

    ctx.session.bankData = { step: 1 };
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
        ? '❌ Wahala dey o. Check your details or try again later. Contact [@maxcswap](https://t.me/maxcswap) if e no work.'
        : '❌ Failed to verify your bank account. Check your details or try again later. Contact [@maxcswap](https://t.me/maxcswap) if it persists.';
      await ctx.replyWithMarkdown(errorMsg);
      delete ctx.session.bankData;
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
    `• *Chains:* Base, BNB, MATIC, ARB (All EVM chains wey dey supported)\n` +
    `• *Address:* \`${walletAddress}\`\n\n` +
    `You fit start send USDC/USDT to this address now from any of these chains, no go send Shiba Inu o, abeg!`
  : `✅ *Bank Account Linked*\n\n` +
    `*Bank Name:* ${bankData.bankName}\n` +
    `*Account Number:* \`${bankData.accountNumber}\`\n` +
    `*Account Holder:* ${bankData.accountName}\n\n` +
    `📂 *Wallet Details:*\n` +
    `• *Chains:* Base, BNB, MATIC, ARB (All supported EVM chains)\n` +
    `• *Address:* \`${walletAddress}\`\n\n` +
    `You can now send USDC/USDT to this address from any of these chains!`;

    await ctx.replyWithPhoto({ source: createReadStream(tempFilePath) }, {
      caption: confirmationMessage,
      parse_mode: 'Markdown',
    });

    await unlinkAsync(tempFilePath);

    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🔗 User ${userId} linked a bank account:\n\n*Account Name:* ${bankData.accountName}\n*Bank Name:* ${bankData.bankName}\n*Account Number:* ${bankData.accountNumber}\n*Wallet Address:* ${walletAddress}`, { parse_mode: 'Markdown' });
    logger.info(`User ${userId} linked a bank account: ${JSON.stringify(userState.wallets[walletIndex].bank)}`);

    // Prompt for refund address
    const refundPrompt = userState.usePidgin
      ? `🔙 *Set Refund Address?*\n\n` +
        `You wan set refund address now? This na the wallet where we go send your funds back if anything scatter. If you no set am, we go use the address wey send the money, and if e no be your own, you fit lose am!\n\n` +
        `You wan set am now?`
      : `🔙 *Set Refund Address?*\n\n` +
        `Would you like to set a refund address now? This is the wallet where we’ll send your funds if a transaction fails. Without it, we’ll use the sender’s address, which could lead to loss if it’s not yours!\n\n` +
        `Set it now?`;
    await ctx.replyWithMarkdown(refundPrompt, Markup.inlineKeyboard([
      [Markup.button.callback('✅ Yes', 'set_refund_now')],
      [Markup.button.callback('❌ Later', 'skip_refund_now')]
    ]));

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

bankLinkingScene.action('set_refund_now', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const prompt = userState.usePidgin
    ? `🔙 *Set Refund Address*\n\n` +
      `Enter your refund address (e.g., 0x123...) where we go send funds if e need refund. Make sure e be valid crypto wallet or funds fit lost!`
    : `🔙 *Set Refund Address*\n\n` +
      `Enter your refund address (e.g., 0x123...) where refunded assets will be sent. Ensure it’s a valid crypto wallet to avoid loss!`;
  await ctx.replyWithMarkdown(prompt);
  ctx.session.awaitingRefundAddress = true;
  ctx.answerCbQuery();
});

bankLinkingScene.action('skip_refund_now', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const msg = userState.usePidgin
    ? '✅ Okay, you fit set refund address later for "⚙️ Settings" > "🔙 Set Refund Address".'
    : '✅ Alright, you can set a refund address later in "⚙️ Settings" > "🔙 Set Refund Address".';
  await ctx.replyWithMarkdown(msg);
  ctx.answerCbQuery();
});

bankLinkingScene.action('confirm_bank_no', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  ctx.session.bankData = { step: 1 };

  const retryMsg = userState.usePidgin
    ? '⚠️ No wahala, let’s fix am. Enter your bank name again (e.g., GTBank, Access):'
    : '⚠️ No worries, let’s correct it. Please enter your bank name again (e.g., GTBank, Access):';
  await ctx.replyWithMarkdown(retryMsg);

  ctx.wizard.selectStep(1);
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

// =================== Register Scenes with Stage ===================
const stage = new Scenes.Stage();
stage.register(bankLinkingScene, sendMessageScene);
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
app.use(bodyParser.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(WEBHOOK_PAYCREST_PATH, bodyParser.raw({ type: 'application/json' }));
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
    [Markup.button.callback('🔙 Set Refund Address', 'settings_set_refund_address')],
    [Markup.button.callback('🔍 Track Transaction', 'settings_track_transaction')],
    [Markup.button.callback('🗣️ Language', 'settings_language')],
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
    [Markup.button.callback('⚖️ Check Wallet Balance', 'admin_check_balance')],
    [Markup.button.callback('🔍 Rescan Deposits', 'admin_rescan_deposits')],
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
  const ip = ctx.requestIp || 'Unknown';
  const isNigeria = ip.startsWith('41.') || ip.startsWith('197.') || ip.startsWith('105.');
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
      ? `👋 Hello, ${userState.firstName}!\n\nWelcome to **DirectPay**. Let’s start your crypto journey.\n\n*First Step:* Click "💼 Generate Wallet" to create your wallet, then link your bank.`
      : `👋 Hello, ${userState.firstName}!\n\nWelcome to **DirectPay**. Let’s begin your crypto journey.\n\n*First Step:* Click "💼 Generate Wallet" to create your wallet and link your bank.`;

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

  if (isNigeria && !userState.usePidgin) {
    await ctx.replyWithMarkdown('👋 You dey Nigeria? Type "Pidgin" anytime or go "⚙️ Settings" > "🗣️ Language" to switch for beta Naija vibes!');
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

      const promptMsg = userState.usePidgin
        ? `✅ *Wallet Don Ready*\n\nWe don create your wallet on ${chain}, but you need link bank first before you fit see the address. Let’s do am now!`
        : `✅ *Wallet Generated*\n\nYour wallet on ${chain} is ready, but you need to link a bank account first to see the address. Let’s do it now!`;
      await ctx.replyWithMarkdown(promptMsg, { reply_markup: getMainMenu(true, false) });

      if (suggestPidgin && !userState.usePidgin) {
        await ctx.replyWithMarkdown('👋 You dey Nigeria? Type "Pidgin" anytime or go "⚙️ Settings" > "🗣️ Language" to switch for beta Naija vibes!');
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
        await ctx.replyWithMarkdown('👋 You dey Nigeria? Type "Pidgin" anytime or go "⚙️ Settings" > "🗣️ Language" to switch for beta Naija vibes!');
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
            `• *Address:* ${wallet.bank ? `\`${wallet.address}\`` : 'Link bank to see address'}\n` +
            `• *Chain:* ${wallet.chain}\n` +
            `• *Created:* ${new Date(wallet.creationDate).toLocaleDateString()}\n` +
            `• *Bank:* ${wallet.bank ? `${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)})` : 'Not Linked'}\n\n`
          : `*Wallet ${walletNumber} (${wallet.name || 'Unnamed'}):*\n` +
            `• *Address:* ${wallet.bank ? `\`${wallet.address}\`` : 'Link bank to see address'}\n` +
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
      await ctx.replyWithMarkdown('👋 You dey Nigeria? Type "Pidgin" anytime or go "⚙️ Settings" > "🗣️ Language" to switch for beta Naija vibes!');
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
            `• *Address:* ${wallet.bank ? `\`${wallet.address}\`` : 'Link bank to see address'}\n` +
            `• *Chain:* ${wallet.chain}\n` +
            `• *Created:* ${new Date(wallet.creationDate).toLocaleDateString()}\n` +
            `• *Bank:* ${wallet.bank ? `${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)})` : 'Not Linked'}\n\n`
          : `*Wallet ${walletNumber} (${wallet.name || 'Unnamed'}):*\n` +
            `• *Address:* ${wallet.bank ? `\`${wallet.address}\`` : 'Link bank to see address'}\n` +
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
      [Markup.button.callback('📅 Filter by Date', 'tx_filter_date')],
      [Markup.button.callback('❌ Exit', 'tx_exit')]
    ]);

    const sentMessage = await ctx.replyWithMarkdown(initialPrompt, inlineKeyboard);
    ctx.session.txMenuMessageId = sentMessage.message_id;
  } catch (error) {
    logger.error(`Error initiating transactions for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Error occurred. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
  }
});

async function displayTransactions(ctx, query, page, filterDescription) {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const pageSize = 5;

  try {
    const snapshot = await query.get();
    const totalTransactions = snapshot.size;
    const totalPages = Math.max(1, Math.ceil(totalTransactions / pageSize));
    const start = (page - 1) * pageSize;
    const limitedQuery = query.offset(start).limit(pageSize);
    const pageSnapshot = await limitedQuery.get();

    let message = userState.usePidgin
      ? `💰 *Your Transactions${filterDescription}* (Page ${page}/${totalPages})\n\n`
      : `💰 *Your Transactions${filterDescription}* (Page ${page}/${totalPages})\n\n`;

    if (pageSnapshot.empty) {
      message += userState.usePidgin
        ? 'No transactions dey here yet.'
        : 'No transactions found yet.';
    } else {
      pageSnapshot.forEach((doc) => {
        const tx = doc.data();
        const blockExplorerUrl = tx.chain === 'Base' ? `https://basescan.org/tx/${tx.transactionHash}` :
                                tx.chain === 'Polygon' ? `https://polygonscan.com/tx/${tx.transactionHash}` :
                                tx.chain === 'BNB Smart Chain' ? `https://bscscan.com/tx/${tx.transactionHash}` : '#';
        message += userState.usePidgin
          ? `*Ref ID:* \`${tx.referenceId}\`\n` +
            `• *Amount:* ${tx.amount} ${tx.asset}\n` +
            `• *NGN Value:* ₦${tx.payout}\n` +
            `• *Status:* ${tx.status === 'Received' ? '✅ Received' : tx.status === 'Pending' ? '⏳ Processing' : tx.status === 'Completed' ? '✅ Completed' : tx.status === 'Refunded' ? '🔄 Refunded' : '❌ ' + tx.status}\n` +
            `• *Tx Hash:* [${tx.transactionHash}](${blockExplorerUrl})\n` +
            `• *Time:* ${new Date(tx.timestamp).toLocaleString()}\n` +
            (tx.paycrestOrderId ? `• *Paycrest Order ID:* \`${tx.paycrestOrderId}\`\n` : '') +
            `\n`
          : `*Reference ID:* \`${tx.referenceId}\`\n` +
            `• *Amount:* ${tx.amount} ${tx.asset}\n` +
            `• *NGN Value:* ₦${tx.payout}\n` +
            `• *Status:* ${tx.status === 'Received' ? '✅ Received' : tx.status === 'Pending' ? '⏳ Processing' : tx.status === 'Completed' ? '✅ Completed' : tx.status === 'Refunded' ? '🔄 Refunded' : '❌ ' + tx.status}\n` +
            `• *Transaction Hash:* [${tx.transactionHash}](${blockExplorerUrl})\n` +
            `• *Time:* ${new Date(tx.timestamp).toLocaleString()}\n` +
            (tx.paycrestOrderId ? `• *Paycrest Order ID:* \`${tx.paycrestOrderId}\`\n` : '') +
            `\n`;
      });
    }

    const navigationButtons = [];
    if (page > 1) navigationButtons.push(Markup.button.callback('⬅️ Previous', `tx_page_${page - 1}_${filterDescription.replace(/\s/g, '_')}`));
    navigationButtons.push(Markup.button.callback('🔄 Refresh', `tx_page_${page}_${filterDescription.replace(/\s/g, '_')}`));
    if (page < totalPages) navigationButtons.push(Markup.button.callback('Next ➡️', `tx_page_${page + 1}_${filterDescription.replace(/\s/g, '_')}`));
    navigationButtons.push(Markup.button.callback('❌ Exit', 'tx_exit'));

    const inlineKeyboard = Markup.inlineKeyboard([navigationButtons]);
    if (ctx.updateType === 'callback_query' && ctx.session.txMessageId) {
      await ctx.telegram.editMessageText(ctx.chat.id, ctx.session.txMessageId, null, message, {
        parse_mode: 'Markdown',
        reply_markup: inlineKeyboard.reply_markup
      });
    } else {
      const sentMessage = await ctx.replyWithMarkdown(message, inlineKeyboard);
      ctx.session.txMessageId = sentMessage.message_id;
    }
  } catch (error) {
    logger.error(`Error displaying transactions for user ${userId}: ${error.message}`);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey showing transactions. Try again later.'
      : '❌ Error displaying transactions. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
  }
}

bot.action('tx_all', async (ctx) => {
  const userId = ctx.from.id.toString();
  const query = db.collection('transactions')
    .where('userId', '==', userId)
    .orderBy('timestamp', 'desc');
  await displayTransactions(ctx, query, 1, '');
  ctx.answerCbQuery();
});

bot.action(/tx_status_(.+)/, async (ctx) => {
  const status = ctx.match[1];
  const userId = ctx.from.id.toString();
  const query = db.collection('transactions')
    .where('userId', '==', userId)
    .where('status', '==', status)
    .orderBy('timestamp', 'desc');
  await displayTransactions(ctx, query, 1, ` - ${status}`);
  ctx.answerCbQuery();
});

bot.action('tx_filter_asset', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const prompt = userState.usePidgin
    ? '🪙 Enter asset to filter (e.g., USDC, USDT):'
    : '🪙 Please enter the asset to filter by (e.g., USDC, USDT):';
  await ctx.replyWithMarkdown(prompt);
  ctx.session.awaitingAssetFilter = true;
  ctx.answerCbQuery();
});

bot.action('tx_filter_date', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const prompt = userState.usePidgin
    ? '📅 Enter date range (e.g., 2023-01-01 to 2023-12-31):'
    : '📅 Please enter the date range (e.g., 2023-01-01 to 2023-12-31):';
  await ctx.replyWithMarkdown(prompt);
  ctx.session.awaitingDateFilter = true;
  ctx.answerCbQuery();
});

bot.action(/tx_page_(\d+)_(.+)/, async (ctx) => {
  const page = parseInt(ctx.match[1], 10);
  const filterDescription = ctx.match[2].replace(/_/g, ' ');
  const userId = ctx.from.id.toString();
  let query = db.collection('transactions').where('userId', '==', userId);

  if (filterDescription.includes('Completed') || filterDescription.includes('Pending') || filterDescription.includes('Failed') || filterDescription.includes('Refunded')) {
    const status = filterDescription.split(' - ')[1];
    query = query.where('status', '==', status);
  } else if (filterDescription.includes('Asset')) {
    const asset = ctx.session.lastAssetFilter;
    query = query.where('asset', '==', asset);
  } else if (filterDescription.includes('Date')) {
    const [start, end] = ctx.session.lastDateFilter.split(' to ');
    query = query.where('timestamp', '>=', new Date(start).toISOString())
                 .where('timestamp', '<=', new Date(end).toISOString());
  }

  query = query.orderBy('timestamp', 'desc');
  await displayTransactions(ctx, query, page, filterDescription);
  ctx.answerCbQuery();
});

bot.action('tx_exit', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  try {
    if (ctx.session.txMessageId) {
      await ctx.telegram.deleteMessage(ctx.chat.id, ctx.session.txMessageId);
      delete ctx.session.txMessageId;
    }
    if (ctx.session.txMenuMessageId) {
      await ctx.telegram.deleteMessage(ctx.chat.id, ctx.session.txMenuMessageId);
      delete ctx.session.txMenuMessageId;
    }
    await ctx.replyWithMarkdown(userState.usePidgin ? '✅ Transaction menu closed!' : '✅ Transaction menu closed!');
  } catch (error) {
    logger.error(`Error exiting transactions for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown(userState.usePidgin ? '❌ Couldn’t close menu. Try again.' : '❌ Failed to close menu. Try again.');
  }
  ctx.answerCbQuery();
});

// =================== Settings Handler ===================
bot.hears('⚙️ Settings', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const prompt = userState.usePidgin
    ? '⚙️ *Settings*\n\nWetin you wan change?'
    : '⚙️ *Settings*\n\nWhat would you like to adjust?';
  await ctx.replyWithMarkdown(prompt, getSettingsMenu());
});

bot.action('settings_generate_wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  
  if (userState.wallets.length >= MAX_WALLETS) {
    const errorMsg = userState.usePidgin
      ? `⚠️ You don reach max wallets (${MAX_WALLETS}).`
      : `⚠️ You’ve reached the maximum wallet limit (${MAX_WALLETS}).`;
    await ctx.replyWithMarkdown(errorMsg);
    return ctx.answerCbQuery();
  }

  await bot.telegram.sendChatAction(ctx.chat.id, 'typing');
  await ctx.replyWithMarkdown(userState.usePidgin
    ? '🔄 Generating new wallet. Wait small...'
    : '🔄 Generating a new wallet. Please wait...');
  await ctx.scene.enter('bank_linking_scene');
  ctx.answerCbQuery();
});

bot.action('settings_edit_bank', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  if (userState.wallets.length === 0) {
    const errorMsg = userState.usePidgin
      ? '❌ No wallet dey to edit bank for.'
      : '❌ You have no wallets to edit bank details for.';
    await ctx.replyWithMarkdown(errorMsg);
    return ctx.answerCbQuery();
  }

  const keyboard = userState.wallets.map((wallet, index) => [
    Markup.button.callback(`Wallet ${index + 1} - ${wallet.chain}${wallet.bank ? ` (${wallet.bank.bankName})` : ''}`, `select_wallet_edit_bank_${index}`)
  ]);
  const prompt = userState.usePidgin
    ? '✏️ Pick wallet to edit bank details:'
    : '✏️ Select a wallet to edit bank details:';
  await ctx.replyWithMarkdown(prompt, Markup.inlineKeyboard(keyboard));
  ctx.answerCbQuery();
});

bot.action(/select_wallet_edit_bank_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);
  const userState = await getUserState(userId);

  if (isNaN(walletIndex) || walletIndex < 0 || walletIndex >= userState.wallets.length) {
    const errorMsg = userState.usePidgin
      ? '❌ Wallet no correct o. Pick one wey dey exist.'
      : '❌ Invalid wallet selection. Please choose an existing wallet.';
    await ctx.replyWithMarkdown(errorMsg);
    return ctx.answerCbQuery();
  }

  delete ctx.session.bankData;
  ctx.session.walletIndex = walletIndex;

  const promptMsg = userState.usePidgin
    ? `✏️ You wan edit bank for Wallet ${walletIndex + 1} (${userState.wallets[walletIndex].chain}). Let’s start fresh!`
    : `✏️ Editing bank details for Wallet ${walletIndex + 1} (${userState.wallets[walletIndex].chain}). Let’s start anew!`;
  await ctx.replyWithMarkdown(promptMsg);

  await ctx.scene.enter('bank_linking_scene');
  await ctx.answerCbQuery();
});

bot.action('settings_rename_wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  if (userState.wallets.length === 0) {
    const errorMsg = userState.usePidgin
      ? '❌ No wallet dey to rename.'
      : '❌ You have no wallets to rename.';
    await ctx.replyWithMarkdown(errorMsg);
    return ctx.answerCbQuery();
  }

  const keyboard = userState.wallets.map((wallet, index) => [
    Markup.button.callback(`Wallet ${index + 1} - ${wallet.chain}`, `rename_wallet_${index}`)
  ]);
  const prompt = userState.usePidgin
    ? '📝 Pick wallet to rename:'
    : '📝 Select a wallet to rename:';
  await ctx.replyWithMarkdown(prompt, Markup.inlineKeyboard(keyboard));
  ctx.answerCbQuery();
});

bot.action(/rename_wallet_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);
  const userState = await getUserState(userId);

  if (walletIndex < 0 || walletIndex >= userState.wallets.length) {
    const errorMsg = userState.usePidgin
      ? '❌ Wallet no dey. Pick correct one.'
      : '❌ Invalid wallet. Please select a valid wallet.';
    await ctx.replyWithMarkdown(errorMsg);
    return ctx.answerCbQuery();
  }

  ctx.session.renameWalletIndex = walletIndex;
  const prompt = userState.usePidgin
    ? `📝 Enter new name for Wallet ${walletIndex + 1} (${userState.wallets[walletIndex].chain}):`
    : `📝 Enter a new name for Wallet ${walletIndex + 1} (${userState.wallets[walletIndex].chain}):`;
  await ctx.replyWithMarkdown(prompt);
  ctx.session.awaitingWalletName = true;
  ctx.answerCbQuery();
});

bot.action('settings_track_transaction', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const prompt = userState.usePidgin
    ? '🔍 Abeg enter the Ref ID wey you wan track (e.g., REF-ABC123):'
    : '🔍 Please enter the Reference ID you want to track (e.g., REF-ABC123):';
  await ctx.replyWithMarkdown(prompt);
  ctx.session.awaitingTrackRef = true;
  ctx.answerCbQuery();
});

bot.action('settings_language', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const currentLang = userState.usePidgin ? 'Pidgin' : 'English';
  const prompt = userState.usePidgin
    ? `🗣️ You dey use *${currentLang}*. Wan switch?`
    : `🗣️ You’re using *${currentLang}*. Want to switch?`;
  await ctx.replyWithMarkdown(prompt, Markup.inlineKeyboard([
    [Markup.button.callback(userState.usePidgin ? '✅ Yes, switch to English' : '✅ Yes, switch to Pidgin', 'switch_language')],
    [Markup.button.callback('❌ No, keep it', 'keep_language')]
  ]));
  ctx.answerCbQuery();
});

bot.action('switch_language', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const newLang = !userState.usePidgin;
  await updateUserState(userId, { usePidgin: newLang });
  const confirmMsg = newLang
    ? `✅ We don switch to Pidgin for you, ${userState.firstName || 'friend'}!`
    : `✅ Switched to English for you, ${userState.firstName || 'user'}!`;
  await ctx.editMessageText(confirmMsg, { parse_mode: 'Markdown' });
  ctx.answerCbQuery();
});

bot.action('keep_language', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const confirmMsg = userState.usePidgin
    ? `✅ Okay, we go keep am as Pidgin!`
    : `✅ Okay, we’ll keep it as English!`;
  await ctx.editMessageText(confirmMsg, { parse_mode: 'Markdown' });
  ctx.answerCbQuery();
});

bot.action('settings_support', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const supportMsg = userState.usePidgin
    ? '💬 Need help? Contact us:\n\n• Telegram: [@maxcswap](https://t.me/maxcswap)'
    : '💬 Need assistance? Reach out:\n\n• Telegram: [@maxcswap](https://t.me/maxcswap)';
  await ctx.replyWithMarkdown(supportMsg);
  ctx.answerCbQuery();
});

bot.action('settings_set_refund_address', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const currentRefundAddress = userState.refundAddress || 'Not set';
  const prompt = userState.usePidgin
    ? `🔙 *Set Refund Address*\n\n` +
      `Current Refund Address: \`${currentRefundAddress}\`\n\n` +
      `Enter new refund address (e.g., 0x123...) where we go send your funds if e need refund. Make sure e be correct crypto address or funds fit lost!`
    : `🔙 *Set Refund Address*\n\n` +
      `Current Refund Address: \`${currentRefundAddress}\`\n\n` +
      `Enter a new refund address (e.g., 0x123...) where refunded assets will be sent. Ensure it’s a valid crypto address to avoid loss!`;
  await ctx.replyWithMarkdown(prompt);
  ctx.session.awaitingRefundAddress = true;
  ctx.answerCbQuery();
});

bot.action('settings_back_main', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const walletExists = userState.wallets.length > 0;
  const hasBankLinked = userState.wallets.some(w => w.bank);
  await ctx.editMessageText(userState.usePidgin
    ? '🏠 Back to main menu!'
    : '🏠 Returning to main menu!', {
    parse_mode: 'Markdown',
    reply_markup: getMainMenu(walletExists, hasBankLinked).reply_markup
  });
  ctx.answerCbQuery();
});

// =================== Support Handler ===================
bot.hears('ℹ️ Support', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const supportMsg = userState.usePidgin
    ? `ℹ️ *Support Menu*\n\n` +
      `Pick your wahala or chat us live:\n\n` +
      `1. *Bank Link Wahala* - If bank no link, check say your account number na 10 digits and bank dey our list.\n` +
      `2. *Transaction Delay* - If e too slow, wait 15 mins, check Ref ID for "⚙️ Settings" > "🔍 Track Transaction".\n` +
      `3. *Refund Address* - Set am for "⚙️ Settings" > "🔙 Set Refund Address" so funds no lost!`
    : `ℹ️ *Support Menu*\n\n` +
      `Select your issue or contact live support:\n\n` +
      `1. *Bank Linking Issues* - If linking fails, ensure your account number is 10 digits and the bank is supported.\n` +
      `2. *Transaction Delays* - If it’s taking too long, wait 15 mins, then track it in "⚙️ Settings" > "🔍 Track Transaction".\n` +
      `3. *Refund Address* - Set it in "⚙️ Settings" > "🔙 Set Refund Address" to avoid losing funds!`;
  await ctx.replyWithMarkdown(supportMsg, Markup.inlineKeyboard([
    [Markup.button.callback(userState.usePidgin ? '📞 Chat Live Support' : '📞 Contact Live Support', 'support_live')],
    [Markup.button.callback('🔙 Back to Menu', 'support_back')]
  ]));
});

bot.action('support_live', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const liveMsg = userState.usePidgin
    ? '📞 Reach us on Telegram: [@maxcswap](https://t.me/maxcswap)\n\nTell us your wahala, we go fix am sharp-sharp!'
    : '📞 Contact us on Telegram: [@maxcswap](https://t.me/maxcswap)\n\nDescribe your issue, and we’ll resolve it quickly!';
  await ctx.editMessageText(liveMsg, { parse_mode: 'Markdown' });
  ctx.answerCbQuery();
});

bot.action('support_back', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const walletExists = userState.wallets.length > 0;
  const hasBankLinked = userState.wallets.some(w => w.bank);
  await ctx.editMessageText(userState.usePidgin ? '🏠 Back to main menu!' : '🏠 Returning to main menu!', {
    parse_mode: 'Markdown',
    reply_markup: getMainMenu(walletExists, hasBankLinked).reply_markup
  });
  ctx.answerCbQuery();
});

// =================== Learn About Base Handler ===================
bot.hears('📘 Learn About Base', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const pages = userState.usePidgin
    ? [
        `📘 *Wetin Be Base? (1/5)*\n\n` +
        `Base na Ethereum Layer 2 (L2) chain wey Coinbase build. E dey fast, cheap, and secure. Imagine say Ethereum na busy Lagos road—Base na like expressway wey dey bypass traffic. E dey use Optimistic Rollups, wey mean say e pack plenty transactions together off-chain, then post am to Ethereum mainnet one time. This make am cost like ₦50 instead of ₦5000 for gas fees! E support USDC and USDT, so you fit send money quick-quick.`,

        `📘 *How Base Dey Work? (2/5)*\n\n` +
        `Base dey roll up transactions—e pack like 100 deals into one small package, then send am to Ethereum. This na why e fast: no need to wait for every single move to settle on mainnet. E get bridge wey connect am to Ethereum, so your funds fit move between Base and main Ethereum smooth. Plus, Coinbase dey run am, so e solid—no shaking! Gas fees dey low because e no dey fight for space with big Ethereum wahala.`,

        `📘 *Why Base Dey Special? (3/5)*\n\n` +
        `Base no be like other chains. E cheap—gas fit be like 1 kobo compared to Ethereum’s ₦100. E fast—transactions settle in seconds, no hours. And e safe—Coinbase, one big crypto oga, dey behind am with plenty security. E dey work with USDC/USDT, wey be stablecoins, so your money no dey dance up and down like BTC. For DirectPay, this mean say your cashout go dey sharp-sharp with small cost!`,

        `📘 *Base and DirectPay (4/5)*\n\n` +
        `For DirectPay, Base na the magic. You send USDC or USDT to your Base wallet wey we give you, then we turn am to Naira fast-fast. No long story—e no dey take days like some bank wahala. We dey use Base because e cheap and quick, so you no go spend plenty on fees, and your money land your bank account before you blink. E dey perfect for Naija wey need speed and value!`,

        `📘 *Why You Go Like Base? (5/5)*\n\n` +
        `Base na game-changer for crypto here. You fit send small money like $1 (₦1500) without losing half to fees. E dey open—anybody with wallet fit use am. E dey grow—more apps dey join Base everyday, so e no go die soon. For you, e mean say DirectPay go give you better rate and faster payout. Finish this lesson, you don sabi how Base dey help you cash out easy!`
      ]
    : [
        `📘 *What is Base? (1/5)*\n\n` +
        `Base is an Ethereum Layer 2 (L2) blockchain developed by Coinbase. It’s designed to be fast, cost-effective, and secure. Think of Ethereum as a crowded highway—Base is like a high-speed bypass. It uses Optimistic Rollups, a technology that bundles hundreds of transactions off-chain and submits them to Ethereum in a single batch. This slashes gas fees from, say, ₦5000 to ₦50! Base supports USDC and USDT, making it ideal for quick, affordable transfers.`,

        `📘 *How Does Base Work? (2/5)*\n\n` +
        `Base operates by "rolling up" transactions—it compresses multiple actions into one compact update, then submits it to Ethereum. This is why it’s so fast: instead of waiting for each transaction to process on the mainnet, it handles them off-chain first. A bridge connects Base to Ethereum, allowing seamless movement of assets between the two. Backed by Coinbase, it’s reliable and robust. The low gas fees come from avoiding the congestion and high costs of Ethereum’s main network.`,

        `📘 *What Makes Base Unique? (3/5)*\n\n` +
        `Base stands out for several reasons. It’s incredibly cost-efficient—gas fees can be as low as a fraction of a naira compared to Ethereum’s ₦100+. It’s fast—transactions confirm in seconds, not hours. It’s secure—built by Coinbase, a leading crypto firm with top-tier security standards. It supports stablecoins like USDC and USDT, ensuring your funds hold steady value. For DirectPay, this translates to rapid, low-cost cashouts tailored to your needs!`,

        `📘 *Base and DirectPay (4/5)*\n\n` +
        `At DirectPay, Base is our secret sauce. You send USDC or USDT to your Base wallet we provide, and we convert it to Naira swiftly. No delays like traditional banking—transactions don’t drag on for days. We chose Base for its low fees and speed, meaning you keep more of your money, and it hits your bank account almost instantly. It’s a perfect fit for Nigeria, where efficiency and affordability matter most!`,

        `📘 *Why You’ll Love Base (5/5)*\n\n` +
        `Base is a revolution for crypto users. You can send small amounts like $1 (₦1500) without fees eating half of it. It’s accessible—anyone with a wallet can use it. It’s future-proof—new apps are joining Base daily, ensuring it grows stronger. For you, it means DirectPay offers better rates and faster payouts. Complete this guide, and you’ll understand how Base empowers you to cash out effortlessly!`
      ];

  ctx.session.learnBasePage = 1;
  await ctx.replyWithMarkdown(pages[0], Markup.inlineKeyboard([
    [Markup.button.callback('Next ➡️', 'learn_base_next')]
  ]));
});

bot.action('learn_base_next', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const pages = userState.usePidgin
    ? [
        `📘 *Wetin Be Base? (1/5)*\n\n` +
        `Base na Ethereum Layer 2 (L2) chain wey Coinbase build. E dey fast, cheap, and secure. Imagine say Ethereum na busy Lagos road—Base na like expressway wey dey bypass traffic. E dey use Optimistic Rollups, wey mean say e pack plenty transactions together off-chain, then post am to Ethereum mainnet one time. This make am cost like ₦50 instead of ₦5000 for gas fees! E support USDC and USDT, so you fit send money quick-quick.`,

        `📘 *How Base Dey Work? (2/5)*\n\n` +
        `Base dey roll up transactions—e pack like 100 deals into one small package, then send am to Ethereum. This na why e fast: no need to wait for every single move to settle on mainnet. E get bridge wey connect am to Ethereum, so your funds fit move between Base and main Ethereum smooth. Plus, Coinbase dey run am, so e solid—no shaking! Gas fees dey low because e no dey fight for space with big Ethereum wahala.`,

        `📘 *Why Base Dey Special? (3/5)*\n\n` +
        `Base no be like other chains. E cheap—gas fit be like 1 kobo compared to Ethereum’s ₦100. E fast—transactions settle in seconds, no hours. And e safe—Coinbase, one big crypto oga, dey behind am with plenty security. E dey work with USDC/USDT, wey be stablecoins, so your money no dey dance up and down like BTC. For DirectPay, this mean say your cashout go dey sharp-sharp with small cost!`,

        `📘 *Base and DirectPay (4/5)*\n\n` +
        `For DirectPay, Base na the magic. You send USDC or USDT to your Base wallet wey we give you, then we turn am to Naira fast-fast. No long story—e no dey take days like some bank wahala. We dey use Base because e cheap and quick, so you no go spend plenty on fees, and your money land your bank account before you blink. E dey perfect for Naija wey need speed and value!`,

        `📘 *Why You Go Like Base? (5/5)*\n\n` +
        `Base na game-changer for crypto here. You fit send small money like $1 (₦1500) without losing half to fees. E dey open—anybody with wallet fit use am. E dey grow—more apps dey join Base everyday, so e no go die soon. For you, e mean say DirectPay go give you better rate and faster payout. Finish this lesson, you don sabi how Base dey help you cash out easy!`
      ]
    : [
        `📘 *What is Base? (1/5)*\n\n` +
        `Base is an Ethereum Layer 2 (L2) blockchain developed by Coinbase. It’s designed to be fast, cost-effective, and secure. Think of Ethereum as a crowded highway—Base is like a high-speed bypass. It uses Optimistic Rollups, a technology that bundles hundreds of transactions off-chain and submits them to Ethereum in a single batch. This slashes gas fees from, say, ₦5000 to ₦50! Base supports USDC and USDT, making it ideal for quick, affordable transfers.`,

        `📘 *How Does Base Work? (2/5)*\n\n` +
        `Base operates by "rolling up" transactions—it compresses multiple actions into one compact update, then submits it to Ethereum. This is why it’s so fast: instead of waiting for each transaction to process on the mainnet, it handles them off-chain first. A bridge connects Base to Ethereum, allowing seamless movement of assets between the two. Backed by Coinbase, it’s reliable and robust. The low gas fees come from avoiding the congestion and high costs of Ethereum’s main network.`,

        `📘 *What Makes Base Unique? (3/5)*\n\n` +
        `Base stands out for several reasons. It’s incredibly cost-efficient—gas fees can be as low as a fraction of a naira compared to Ethereum’s ₦100+. It’s fast—transactions confirm in seconds, not hours. It’s secure—built by Coinbase, a leading crypto firm with top-tier security standards. It supports stablecoins like USDC and USDT, ensuring your funds hold steady value. For DirectPay, this translates to rapid, low-cost cashouts tailored to your needs!`,

        `📘 *Base and DirectPay (4/5)*\n\n` +
        `At DirectPay, Base is our secret sauce. You send USDC or USDT to your Base wallet we provide, and we convert it to Naira swiftly. No delays like traditional banking—transactions don’t drag on for days. We chose Base for its low fees and speed, meaning you keep more of your money, and it hits your bank account almost instantly. It’s a perfect fit for Nigeria, where efficiency and affordability matter most!`,

        `📘 *Why You’ll Love Base (5/5)*\n\n` +
        `Base is a revolution for crypto users. You can send small amounts like $1 (₦1500) without fees eating half of it. It’s accessible—anyone with a wallet can use it. It’s future-proof—new apps are joining Base daily, ensuring it grows stronger. For you, it means DirectPay offers better rates and faster payouts. Complete this guide, and you’ll understand how Base empowers you to cash out effortlessly!`
      ];
  
  ctx.session.learnBasePage = (ctx.session.learnBasePage || 1) + 1;
  if (ctx.session.learnBasePage > pages.length) ctx.session.learnBasePage = 1;

  const buttons = [];
  if (ctx.session.learnBasePage > 1) buttons.push(Markup.button.callback('⬅️ Previous', 'learn_base_prev'));
  if (ctx.session.learnBasePage < pages.length) buttons.push(Markup.button.callback('Next ➡️', 'learn_base_next'));
  if (ctx.session.learnBasePage === pages.length) buttons.push(Markup.button.callback('❌ Exit', 'learn_base_exit'));
  
  await ctx.editMessageText(pages[ctx.session.learnBasePage - 1], {
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard([buttons]).reply_markup
  });
  ctx.answerCbQuery();
});

bot.action('learn_base_prev', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const pages = userState.usePidgin
    ? [
        `📘 *Wetin Be Base? (1/5)*\n\n` +
        `Base na Ethereum Layer 2 (L2) chain wey Coinbase build. E dey fast, cheap, and secure. Imagine say Ethereum na busy Lagos road—Base na like expressway wey dey bypass traffic. E dey use Optimistic Rollups, wey mean say e pack plenty transactions together off-chain, then post am to Ethereum mainnet one time. This make am cost like ₦50 instead of ₦5000 for gas fees! E support USDC and USDT, so you fit send money quick-quick.`,

        `📘 *How Base Dey Work? (2/5)*\n\n` +
        `Base dey roll up transactions—e pack like 100 deals into one small package, then send am to Ethereum. This na why e fast: no need to wait for every single move to settle on mainnet. E get bridge wey connect am to Ethereum, so your funds fit move between Base and main Ethereum smooth. Plus, Coinbase dey run am, so e solid—no shaking! Gas fees dey low because e no dey fight for space with big Ethereum wahala.`,

        `📘 *Why Base Dey Special? (3/5)*\n\n` +
        `Base no be like other chains. E cheap—gas fit be like 1 kobo compared to Ethereum’s ₦100. E fast—transactions settle in seconds, no hours. And e safe—Coinbase, one big crypto oga, dey behind am with plenty security. E dey work with USDC/USDT, wey be stablecoins, so your money no dey dance up and down like BTC. For DirectPay, this mean say your cashout go dey sharp-sharp with small cost!`,

        `📘 *Base and DirectPay (4/5)*\n\n` +
        `For DirectPay, Base na the magic. You send USDC or USDT to your Base wallet wey we give you, then we turn am to Naira fast-fast. No long story—e no dey take days like some bank wahala. We dey use Base because e cheap and quick, so you no go spend plenty on fees, and your money land your bank account before you blink. E dey perfect for Naija wey need speed and value!`,

        `📘 *Why You Go Like Base? (5/5)*\n\n` +
        `Base na game-changer for crypto here. You fit send small money like $1 (₦1500) without losing half to fees. E dey open—anybody with wallet fit use am. E dey grow—more apps dey join Base everyday, so e no go die soon. For you, e mean say DirectPay go give you better rate and faster payout. Finish this lesson, you don sabi how Base dey help you cash out easy!`
      ]
    : [
        `📘 *What is Base? (1/5)*\n\n` +
        `Base is an Ethereum Layer 2 (L2) blockchain developed by Coinbase. It’s designed to be fast, cost-effective, and secure. Think of Ethereum as a crowded highway—Base is like a high-speed bypass. It uses Optimistic Rollups, a technology that bundles hundreds of transactions off-chain and submits them to Ethereum in a single batch. This slashes gas fees from, say, ₦5000 to ₦50! Base supports USDC and USDT, making it ideal for quick, affordable transfers.`,

        `📘 *How Does Base Work? (2/5)*\n\n` +
        `Base operates by "rolling up" transactions—it compresses multiple actions into one compact update, then submits it to Ethereum. This is why it’s so fast: instead of waiting for each transaction to process on the mainnet, it handles them off-chain first. A bridge connects Base to Ethereum, allowing seamless movement of assets between the two. Backed by Coinbase, it’s reliable and robust. The low gas fees come from avoiding the congestion and high costs of Ethereum’s main network.`,

        `📘 *What Makes Base Unique? (3/5)*\n\n` +
        `Base stands out for several reasons. It’s incredibly cost-efficient—gas fees can be as low as a fraction of a naira compared to Ethereum’s ₦100+. It’s fast—transactions confirm in seconds, not hours. It’s secure—built by Coinbase, a leading crypto firm with top-tier security standards. It supports stablecoins like USDC and USDT, ensuring your funds hold steady value. For DirectPay, this translates to rapid, low-cost cashouts tailored to your needs!`,

        `📘 *Base and DirectPay (4/5)*\n\n` +
        `At DirectPay, Base is our secret sauce. You send USDC or USDT to your Base wallet we provide, and we convert it to Naira swiftly. No delays like traditional banking—transactions don’t drag on for days. We chose Base for its low fees and speed, meaning you keep more of your money, and it hits your bank account almost instantly. It’s a perfect fit for Nigeria, where efficiency and affordability matter most!`,

        `📘 *Why You’ll Love Base (5/5)*\n\n` +
        `Base is a revolution for crypto users. You can send small amounts like $1 (₦1500) without fees eating half of it. It’s accessible—anyone with a wallet can use it. It’s future-proof—new apps are joining Base daily, ensuring it grows stronger. For you, it means DirectPay offers better rates and faster payouts. Complete this guide, and you’ll understand how Base empowers you to cash out effortlessly!`
      ];
  
  ctx.session.learnBasePage = (ctx.session.learnBasePage || 1) - 1;
  if (ctx.session.learnBasePage < 1) ctx.session.learnBasePage = pages.length;

  const buttons = [];
  if (ctx.session.learnBasePage > 1) buttons.push(Markup.button.callback('⬅️ Previous', 'learn_base_prev'));
  if (ctx.session.learnBasePage < pages.length) buttons.push(Markup.button.callback('Next ➡️', 'learn_base_next'));
  if (ctx.session.learnBasePage === pages.length) buttons.push(Markup.button.callback('❌ Exit', 'learn_base_exit'));
  
  await ctx.editMessageText(pages[ctx.session.learnBasePage - 1], {
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard([buttons]).reply_markup
  });
  ctx.answerCbQuery();
});

bot.action('learn_base_exit', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const exitMsg = userState.usePidgin
    ? `🙌 *Thanks for Learning About Base!*\n\nYou don sabi how Base dey make your crypto life easy. Wetin you wan do next?`
    : `🙌 *Thanks for Learning About Base!*\n\nYou’ve mastered how Base simplifies your crypto experience. What’s next?`;
  await ctx.editMessageText(exitMsg, {
    parse_mode: 'Markdown',
    reply_markup: getMainMenu(userState.wallets.length > 0, userState.wallets.some(w => w.bank)).reply_markup
  });
  delete ctx.session.learnBasePage;
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
    ? `\nThese rates dey fresh from Paycrest as of ${new Date().toLocaleString()}`
    : `\nRates updated from Paycrest as of ${new Date().toLocaleString()}`;
  await ctx.replyWithMarkdown(ratesMessage);
});

// =================== Text Handler ===================
bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  let userState;

  try {
    userState = await getUserState(userId);
  } catch (error) {
    logger.error(`Failed to get user state in text handler for ${userId}: ${error.message}`);
    const errorMsg = userState?.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Error occurred. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    return;
  }

  if (ctx.message.text.toLowerCase() === 'pidgin') {
    await updateUserState(userId, { usePidgin: true });
    const confirmMsg = `✅ We don switch to Pidgin for you, ${userState.firstName || 'friend'}! Wetin you wan do now?`;
    await ctx.replyWithMarkdown(confirmMsg, getMainMenu(userState.wallets.length > 0, userState.wallets.some(w => w.bank)));
    return;
  }

  if (ctx.session.awaitingAssetFilter) {
    const asset = ctx.message.text.trim().toUpperCase();
    ctx.session.awaitingAssetFilter = false;
    if (!SUPPORTED_ASSETS.includes(asset)) {
      const errorMsg = userState.usePidgin
        ? `❌ Asset "${asset}" no dey supported. Try USDC or USDT.`
        : `❌ Asset "${asset}" is not supported. Try USDC or USDT.`;
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }
    ctx.session.lastAssetFilter = asset;
    const query = db.collection('transactions')
      .where('userId', '==', userId)
      .where('asset', '==', asset)
      .orderBy('timestamp', 'desc');
    await displayTransactions(ctx, query, 1, ` - Asset ${asset}`);
    return;
  }

  if (ctx.session.awaitingDateFilter) {
    const dateRange = ctx.message.text.trim();
    ctx.session.awaitingDateFilter = false;
    const [start, end] = dateRange.split(' to ');
    if (!start || !end || isNaN(Date.parse(start)) || isNaN(Date.parse(end))) {
      const errorMsg = userState.usePidgin
        ? '❌ Date range no correct. Use "YYYY-MM-DD to YYYY-MM-DD" (e.g., 2023-01-01 to 2023-12-31).'
        : '❌ Invalid date range format. Use "YYYY-MM-DD to YYYY-MM-DD" (e.g., 2023-01-01 to 2023-12-31).';
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }
    ctx.session.lastDateFilter = dateRange;
    const query = db.collection('transactions')
      .where('userId', '==', userId)
      .where('timestamp', '>=', new Date(start).toISOString())
      .where('timestamp', '<=', new Date(end).toISOString())
      .orderBy('timestamp', 'desc');
    await displayTransactions(ctx, query, 1, ` - Date ${dateRange}`);
    return;
  }

  if (ctx.session.awaitingWalletName) {
    const newName = ctx.message.text.trim();
    const walletIndex = ctx.session.renameWalletIndex;
    ctx.session.awaitingWalletName = false;

    if (!newName || newName.length > 50) {
      const errorMsg = userState.usePidgin
        ? '❌ Name no good. Use something short (max 50 characters).'
        : '❌ Invalid name. Please use a name up to 50 characters.';
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }

    userState.wallets[walletIndex].name = newName;
    await updateUserState(userId, { wallets: userState.wallets });
    const successMsg = userState.usePidgin
      ? `✅ Wallet ${walletIndex + 1} don turn "${newName}"!`
      : `✅ Wallet ${walletIndex + 1} renamed to "${newName}"!`;
    await ctx.replyWithMarkdown(successMsg);
    delete ctx.session.renameWalletIndex;
    return;
  }

  if (ctx.session.awaitingTrackRef) {
    const refId = ctx.message.text.trim();
    ctx.session.awaitingTrackRef = false;

    const txSnapshot = await db.collection('transactions').where('referenceId', '==', refId).where('userId', '==', userId).get();

    if (txSnapshot.empty) {
      const errorMsg = userState.usePidgin
        ? `❌ No transaction dey with Ref ID \`${refId}\`. Check am well!`
        : `❌ No transaction found with Reference ID \`${refId}\`. Double-check it!`;
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }

    const tx = txSnapshot.docs[0].data();
    const blockExplorerUrl = tx.chain === 'Base' ? `https://basescan.org/tx/${tx.transactionHash}` :
                            tx.chain === 'Polygon' ? `https://polygonscan.com/tx/${tx.transactionHash}` :
                            tx.chain === 'BNB Smart Chain' ? `https://bscscan.com/tx/${tx.transactionHash}` : '#';

    const statusMsg = userState.usePidgin
      ? `🔍 *Transaction Status*\n\n` +
        `*Ref ID:* \`${refId}\`\n` +
        `*Amount:* ${tx.amount} ${tx.asset}\n` +
        `*NGN Value:* ₦${tx.payout}\n` +
        `*Status:* ${tx.status === 'Received' ? '✅ Received' : tx.status === 'Pending' ? '⏳ Processing' : tx.status === 'Completed' ? '✅ Completed' : tx.status === 'Refunded' ? '🔄 Refunded' : '❌ ' + tx.status}\n` +
        `*Tx Hash:* [${tx.transactionHash}](${blockExplorerUrl})\n` +
        (tx.paycrestOrderId ? `*Paycrest Order ID:* \`${tx.paycrestOrderId}\`\n` : '') +
        `*Time:* ${new Date(tx.timestamp).toLocaleString()}\n\n` +
        (tx.status === 'Received' ? 'We don get am, dey process—chill small!' :
         tx.status === 'Pending' ? 'E dey move, no wahala, e go soon land!' :
         tx.status === 'Completed' ? 'E don finish—money don enter your bank!' :
         tx.status === 'Refunded' ? 'We don return am back to your wallet!' : 'E get small delay, but we dey on am!')
      : `🔍 *Transaction Status*\n\n` +
        `*Reference ID:* \`${refId}\`\n` +
        `*Amount:* ${tx.amount} ${tx.asset}\n` +
        `*NGN Value:* ₦${tx.payout}\n` +
        `*Status:* ${tx.status === 'Received' ? '✅ Received' : tx.status === 'Pending' ? '⏳ Processing' : tx.status === 'Completed' ? '✅ Completed' : tx.status === 'Refunded' ? '🔄 Refunded' : '❌ ' + tx.status}\n` +
        `*Transaction Hash:* [${tx.transactionHash}](${blockExplorerUrl})\n` +
        (tx.paycrestOrderId ? `*Paycrest Order ID:* \`${tx.paycrestOrderId}\`\n` : '') +
        `*Time:* ${new Date(tx.timestamp).toLocaleString()}\n\n` +
        (tx.status === 'Received' ? 'We’ve received it and are processing—no worries!' :
         tx.status === 'Pending' ? 'It’s in progress, no stress, it’ll land soon!' :
         tx.status === 'Completed' ? 'All done—funds are in your bank!' :
         tx.status === 'Refunded' ? 'It’s been refunded to your wallet!' : 'There’s a slight delay, but we’re on it!');
    await ctx.replyWithMarkdown(statusMsg);
    return;
  }

  if (ctx.session.awaitingRefundAddress) {
    const refundAddress = ctx.message.text.trim();
    ctx.session.awaitingRefundAddress = false;

    if (!/^0x[a-fA-F0-9]{40}$/.test(refundAddress)) {
      const errorMsg = userState.usePidgin
        ? '❌ Address no correct. Use valid crypto address (e.g., 0x123... with 42 characters).'
        : '❌ Invalid address. Please enter a valid crypto address (e.g., 0x123... with 42 characters).';
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }

    await updateUserState(userId, { refundAddress });
    const successMsg = userState.usePidgin
      ? `✅ Refund address set to \`${refundAddress}\`! If anything refund, e go land here.\n\n📝 How you see this process? Reply with "Good" or "Bad" or anything!`
      : `✅ Refund address set to \`${refundAddress}\`! Refunds will be sent here.\n\n📝 How was this process? Reply with "Good" or "Bad" or any feedback!`;
    await ctx.replyWithMarkdown(successMsg);
    ctx.session.awaitingFeedback = 'refund_address';
    return;
  }

  if (ctx.session.awaitingFeedback) {
    const feedback = ctx.message.text.trim();
    const feedbackType = ctx.session.awaitingFeedback;
    delete ctx.session.awaitingFeedback;

    const logMsg = `Feedback from user ${userId} on ${feedbackType}: ${feedback}`;
    logger.info(logMsg);
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, logMsg);

    const thankYouMsg = userState.usePidgin
      ? '🙏 Thanks for your feedback! We go use am make things better.'
      : '🙏 Thank you for your feedback! We’ll use it to improve.';
    await ctx.replyWithMarkdown(thankYouMsg);
    return;
  }

  const defaultMsg = userState.usePidgin
    ? '👀 Wetin you dey find? Use the menu below!'
    : '👀 Not sure what you mean. Use the menu below!';
  await ctx.replyWithMarkdown(defaultMsg, getMainMenu(userState.wallets.length > 0, userState.wallets.some(w => w.bank)));
});

// =================== Admin Panel ===================
bot.action('open_admin_panel', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    await ctx.replyWithMarkdown('❌ You no be admin.');
    return ctx.answerCbQuery();
  }

  const userState = await getUserState(userId);
  const prompt = userState.usePidgin
    ? '🔧 *Admin Panel*\n\nWetin you wan do?'
    : '🔧 *Admin Panel*\n\nWhat would you like to do?';
  await ctx.editMessageText(prompt, {
    parse_mode: 'Markdown',
    reply_markup: getAdminMenu().reply_markup
  });
  ctx.answerCbQuery();
});

bot.action('admin_send_message', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    await ctx.replyWithMarkdown('❌ You no be admin.');
    return ctx.answerCbQuery();
  }
  await ctx.scene.enter('send_message_scene');
  ctx.answerCbQuery();
});

bot.action('admin_check_balance', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) return ctx.answerCbQuery('❌ You no be admin.');
  const userState = await getUserState(userId);
  const prompt = userState.usePidgin
    ? '⚖️ Enter User ID to check wallet balance:'
    : '⚖️ Enter the User ID to check wallet balance:';
  await ctx.replyWithMarkdown(prompt);
  ctx.session.awaitingAdminUserId = 'check_balance';
  ctx.answerCbQuery();
});

bot.action('admin_rescan_deposits', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) return ctx.answerCbQuery('❌ You no be admin.');
  const userState = await getUserState(userId);
  const prompt = userState.usePidgin
    ? '🔍 Enter Ref ID to rescan deposit:'
    : '🔍 Enter Reference ID to rescan deposit:';
  await ctx.replyWithMarkdown(prompt);
  ctx.session.awaitingAdminRefId = 'rescan_deposits';
  ctx.answerCbQuery();
});

bot.action('admin_refund_tx', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) return ctx.answerCbQuery('❌ You no be admin.');
  const userState = await getUserState(userId);
  const prompt = userState.usePidgin
    ? '🔄 Enter Ref ID to refund transaction:'
    : '🔄 Enter Reference ID to refund transaction:';
  await ctx.replyWithMarkdown(prompt);
  ctx.session.awaitingAdminRefId = 'refund_tx';
  ctx.answerCbQuery();
});

bot.action('admin_back_to_main', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const walletExists = userState.wallets.length > 0;
  const hasBankLinked = userState.wallets.some(w => w.bank);
  await ctx.editMessageText(userState.usePidgin
    ? '🏠 Back to main menu!'
    : '🏠 Returning to main menu!', {
    parse_mode: 'Markdown',
    reply_markup: getMainMenu(walletExists, hasBankLinked).reply_markup
  });
  ctx.answerCbQuery();
});

// Admin text handler for inputs
bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  if (ctx.session.awaitingAdminUserId === 'check_balance') {
    const targetUserId = ctx.message.text.trim();
    ctx.session.awaitingAdminUserId = false;

    const targetState = await getUserState(targetUserId);
    if (!targetState.wallets.length) {
      await ctx.replyWithMarkdown(userState.usePidgin
        ? `❌ User ${targetUserId} no get wallets.`
        : `❌ User ${targetUserId} has no wallets.`);
      return;
    }

    let balanceMsg = userState.usePidgin
      ? `⚖️ *Wallet Balances for User ${targetUserId}*\n\n`
      : `⚖️ *Wallet Balances for User ${targetUserId}*\n\n`;
    for (const wallet of targetState.wallets) {
      for (const asset of wallet.supportedAssets) {
        const balanceData = await getWalletBalance(chains[wallet.chain].id, chains[wallet.chain].assets[asset], wallet.chain);
        balanceMsg += `• *${wallet.chain} - ${asset}*: ${balanceData.balance} (${balanceData.convertedBalance} USD)\n`;
      }
    }
    await ctx.replyWithMarkdown(balanceMsg);
    return;
  }

  if (ctx.session.awaitingAdminRefId === 'rescan_deposits') {
    const refId = ctx.message.text.trim();
    ctx.session.awaitingAdminRefId = false;

    const txSnapshot = await db.collection('transactions').where('referenceId', '==', refId).get();
    if (txSnapshot.empty) {
      await ctx.replyWithMarkdown(userState.usePidgin
        ? `❌ No transaction dey with Ref ID \`${refId}\`.`
        : `❌ No transaction found with Reference ID \`${refId}\`.`);
      return;
    }

    const tx = txSnapshot.docs[0].data();
    const chainKey = chainMapping[tx.chain.toLowerCase()];
    await rescanBlocks(chains[chainKey].id, tx.transactionHash, chainKey);
    await ctx.replyWithMarkdown(userState.usePidgin
      ? `✅ Block rescan started for Ref ID \`${refId}\`.`
      : `✅ Block rescan initiated for Reference ID \`${refId}\`.`);
    return;
  }

  if (ctx.session.awaitingAdminRefId === 'refund_tx') {
    const refId = ctx.message.text.trim();
    ctx.session.awaitingAdminRefId = false;

    const txSnapshot = await db.collection('transactions').where('referenceId', '==', refId).get();
    if (txSnapshot.empty) {
      await ctx.replyWithMarkdown(userState.usePidgin
        ? `❌ No transaction dey with Ref ID \`${refId}\`.`
        : `❌ No transaction found with Reference ID \`${refId}\`.`);
      return;
    }

    const tx = txSnapshot.docs[0].data();
    const targetState = await getUserState(tx.userId);
    const refundAddress = targetState.refundAddress || tx.senderAddress;
    const chainKey = chainMapping[tx.chain.toLowerCase()];
    const networkFee = await calculateWithdrawFee(chains[chainKey].id, 'default_address_id', chains[chainKey].assets[tx.asset], refundAddress, tx.amount, chainKey);

    await withdrawFromBlockradar(tx.chain, chains[chainKey].assets[tx.asset], refundAddress, tx.amount, refId, { reason: 'Manual refund' });
    await db.collection('transactions').doc(refId).update({ status: 'Refunded', refundAddress, updatedAt: new Date().toISOString() });

    const refundMsg = userState.usePidgin
      ? `✅ Refunded ${tx.amount} ${tx.asset} to \`${refundAddress}\` for Ref ID \`${refId}\`. Fee: ${networkFee} ETH.`
      : `✅ Refunded ${tx.amount} ${tx.asset} to \`${refundAddress}\` for Reference ID \`${refId}\`. Fee: ${networkFee} ETH.`;
    await ctx.replyWithMarkdown(refundMsg);
    return;
  }
});

// Placeholder for other admin actions
bot.action('admin_view_all_transactions', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) return ctx.answerCbQuery('❌ You no be admin.');
  const userState = await getUserState(userId);
  await ctx.replyWithMarkdown(userState.usePidgin
    ? '📋 Work in progress. E go soon ready!'
    : '📋 Work in progress. Coming soon!');
  ctx.answerCbQuery();
});

// =================== Webhook Handlers ===================
app.post(WEBHOOK_BLOCKRADAR_PATH, async (req, res) => {
  const { eventType, chain, data } = req.body;
  const clientIp = req.clientIp;

  if (!eventType || !chain || !data) {
    logger.error(`Invalid Blockradar webhook payload from IP ${clientIp}: ${JSON.stringify(req.body)}`);
    return res.status(400).send('Invalid payload');
  }

  logger.info(`Received Blockradar webhook event: ${eventType} from IP: ${clientIp}`);

  try {
    const chainRaw = chainMapping[chain.toLowerCase()] || chain;
    const userIdSnapshot = await db.collection('users')
      .where('walletAddresses', 'array-contains', data.recipientAddress)
      .limit(1)
      .get();

    if (userIdSnapshot.empty) {
      logger.warn(`No user found for wallet address ${data.recipientAddress} from IP ${clientIp}`);
      return res.status(404).send('User not found');
    }

    const userDoc = userIdSnapshot.docs[0];
    const userId = userDoc.id;
    const userState = await getUserState(userId);
    const wallet = userState.wallets.find(w => w.address === data.recipientAddress);

    if (!wallet) {
      logger.error(`Wallet ${data.recipientAddress} not found in user ${userId}'s wallets`);
      return res.status(404).send('Wallet not found');
    }

    if (eventType === 'deposit.success') {
      const { amount, asset, transactionHash, senderAddress } = data;
      const referenceId = generateReferenceId();
      const rate = exchangeRates[asset.symbol];
      const ngnAmount = calculatePayout(asset.symbol, amount);
      const walletAddress = wallet.address;

      const txData = {
        userId,
        firstName: userState.firstName || 'Unknown',
        walletAddress,
        chain: chainRaw,
        amount: parseFloat(amount),
        asset: asset.symbol,
        payout: ngnAmount,
        status: 'Received',
        referenceId,
        transactionHash,
        senderAddress,
        timestamp: new Date().toISOString(),
        bankDetails: wallet.bank || null,
      };

      await db.collection('transactions').doc(referenceId).set(txData);
      wallet.totalDeposits += parseFloat(amount);
      await updateUserState(userId, { wallets: userState.wallets, hasReceivedDeposit: true });

      const blockExplorerUrl = chainRaw === 'Base' ? `https://basescan.org/tx/${transactionHash}` :
                              chainRaw === 'Polygon' ? `https://polygonscan.com/tx/${transactionHash}` :
                              chainRaw === 'BNB Smart Chain' ? `https://bscscan.com/tx/${transactionHash}` : '#';

      const depositMsg = userState.usePidgin
        ? `💰 *Deposit Don Land!*\n\n` +
          `*Ref ID:* \`${referenceId}\`\n` +
          `*Amount:* ${amount} ${asset.symbol}\n` +
          `*Rate:* ₦${rate} per ${asset.symbol}\n` +
          `*NGN Value:* ₦${ngnAmount}\n` +
          `*From Address:* \`${senderAddress}\`\n` +
          `*To Wallet:* \`${walletAddress}\`\n` +
          `*Network:* ${chainRaw}\n` +
          `*Tx Hash:* [${transactionHash}](${blockExplorerUrl})\n` +
          `*Date:* ${new Date().toLocaleString()}\n\n` +
          `We dey process am—cash go reach your bank (${wallet.bank.bankName}, ****${wallet.bank.accountNumber.slice(-4)}) soon!`
        : `💰 *Deposit Received!*\n\n` +
          `*Reference ID:* \`${referenceId}\`\n` +
          `*Amount:* ${amount} ${asset.symbol}\n` +
          `*Rate:* ₦${rate} per ${asset.symbol}\n` +
          `*NGN Value:* ₦${ngnAmount}\n` +
          `*From Address:* \`${senderAddress}\`\n` +
          `*To Wallet:* \`${walletAddress}\`\n` +
          `*Network:* ${chainRaw}\n` +
          `*Transaction Hash:* [${transactionHash}](${blockExplorerUrl})\n` +
          `*Date:* ${new Date().toLocaleString()}\n\n` +
          `We’re processing it—funds will reach your bank (${wallet.bank.bankName}, ****${wallet.bank.accountNumber.slice(-4)}) soon!`;
      await bot.telegram.sendPhoto(userId, { source: DEPOSIT_SUCCESS_IMAGE }, {
        caption: depositMsg,
        parse_mode: 'Markdown'
      });

      logger.info(`Deposit processed for user ${userId}: ${amount} ${asset.symbol}, Ref ID: ${referenceId}`);

      if (wallet.bank) {
        const order = await createPaycrestOrder(userId, amount, asset.symbol, chainRaw, wallet.bank, userState.refundAddress || senderAddress);
        await db.collection('transactions').doc(referenceId).update({
          paycrestOrderId: order.orderId,
          status: 'Pending'
        });

        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `💸 *Deposit Processing*\n\n` +
          `*User ID:* ${userId}\n` +
          `*First Name:* ${userState.firstName || 'Unknown'}\n` +
          `*Ref ID:* \`${referenceId}\`\n` +
          `*Amount:* ${amount} ${asset.symbol}\n` +
          `*NGN Value:* ₦${ngnAmount}\n` +
          `*Tx Hash:* [${transactionHash}](${blockExplorerUrl})\n` +
          `*Bank:* ${wallet.bank.bankName}\n` +
          `*Account Number:* ${wallet.bank.accountNumber}\n` +
          `*Receiver:* ${wallet.bank.accountName}\n` +
          `*Paycrest Order ID:* ${order.orderId}\n` +
          `*Time:* ${new Date().toLocaleString()}`, { parse_mode: 'Markdown' });
      } else {
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ *Deposit Received but No Bank Linked*\n\n` +
          `*User ID:* ${userId}\n` +
          `*Ref ID:* \`${referenceId}\`\n` +
          `*Amount:* ${amount} ${asset.symbol}\n` +
          `*NGN Value:* ₦${ngnAmount}\n` +
          `*Tx Hash:* [${transactionHash}](${blockExplorerUrl})\n` +
          `*Wallet:* ${walletAddress}\n` +
          `*Time:* ${new Date().toLocaleString()}\n\n` +
          `User needs to link a bank account to proceed!`, { parse_mode: 'Markdown' });
      }

      res.status(200).send('OK');
    } else {
      logger.warn(`Unhandled Blockradar event type: ${eventType} from IP ${clientIp}`);
      res.status(200).send('OK');
    }
  } catch (error) {
    logger.error(`Error processing Blockradar webhook from IP ${clientIp}: ${error.message}`);
    res.status(500).send('Internal Server Error');
  }
});

app.post(WEBHOOK_PAYCREST_PATH, async (req, res) => {
  const signature = req.headers['x-paycrest-signature'];
  const rawBody = req.rawBody;
  const clientIp = req.clientIp;

  if (!signature) {
    logger.error(`No Paycrest signature found in headers from IP: ${clientIp}`);
    return res.status(400).send('Signature missing.');
  }

  if (!Buffer.isBuffer(rawBody)) {
    logger.error(`Invalid raw body type from IP: ${clientIp}: ${typeof rawBody}`);
    return res.status(400).send('Invalid body type.');
  }

  if (!verifyPaycrestSignature(rawBody, signature, PAYCREST_CLIENT_SECRET)) {
    logger.error(`Invalid Paycrest signature from IP: ${clientIp}`);
    return res.status(401).send('Invalid signature.');
  }

  let parsedBody;
  try {
    parsedBody = JSON.parse(rawBody.toString());
  } catch (error) {
    logger.error(`Failed to parse Paycrest webhook body from IP: ${clientIp} - ${error.message}`);
    return res.status(400).send('Invalid JSON.');
  }

  const { event, data } = parsedBody;
  if (!event || !data) {
    logger.error(`Missing event or data in Paycrest webhook from IP: ${clientIp}`);
    return res.status(400).send('Invalid webhook payload.');
  }

  logger.info(`Received Paycrest event: ${event} from IP: ${clientIp}`);

  switch (event) {
    case 'payment_order.pending':
      await handlePaymentOrderPending(data, res);
      break;
    case 'payment_order.expired':
      await handlePaymentOrderExpired(data, res);
      break;
    case 'payment_order.settled':
      await handlePaymentOrderSettled(data, res);
      break;
    case 'payment_order.refunded':
      await handlePaymentOrderRefunded(data, res);
      break;
    default:
      logger.warn(`Unhandled Paycrest webhook event type: ${event} from IP ${clientIp}`);
      res.status(200).send('OK');
  }
});

async function handlePaymentOrderPending(data, res) {
  const { orderId } = data;
  const txSnapshot = await db.collection('transactions')
    .where('paycrestOrderId', '==', orderId)
    .limit(1)
    .get();

  if (txSnapshot.empty) {
    logger.warn(`No transaction found for Paycrest order ${orderId}`);
    return res.status(404).send('Transaction not found');
  }

  const txDoc = txSnapshot.docs[0];
  const txData = txDoc.data();
  const userId = txData.userId;
  const userState = await getUserState(userId);
  const blockExplorerUrl = txData.chain === 'Base' ? `https://basescan.org/tx/${txData.transactionHash}` :
                          txData.chain === 'Polygon' ? `https://polygonscan.com/tx/${txData.transactionHash}` :
                          txData.chain === 'BNB Smart Chain' ? `https://bscscan.com/tx/${txData.transactionHash}` : '#';

  await db.collection('transactions').doc(txData.referenceId).update({ status: 'Pending' });

  const msg = userState.usePidgin
    ? `⏳ *Transaction Update*\n\n` +
      `*Ref ID:* \`${txData.referenceId}\`\n` +
      `*Amount:* ${txData.amount} ${txData.asset}\n` +
      `*NGN Value:* ₦${txData.payout}\n` +
      `*Status:* Processing\n` +
      `*Tx Hash:* [${txData.transactionHash}](${blockExplorerUrl})\n` +
      `*Paycrest Order ID:* \`${orderId}\`\n` +
      `*Time:* ${new Date().toLocaleString()}\n\n` +
      `E dey move, no wahala, e go soon land!`
    : `⏳ *Transaction Update*\n\n` +
      `*Reference ID:* \`${txData.referenceId}\`\n` +
      `*Amount:* ${txData.amount} ${txData.asset}\n` +
      `*NGN Value:* ₦${txData.payout}\n` +
      `*Status:* Processing\n` +
      `*Transaction Hash:* [${txData.transactionHash}](${blockExplorerUrl})\n` +
      `*Paycrest Order ID:* \`${orderId}\`\n` +
      `*Time:* ${new Date().toLocaleString()}\n\n` +
      `It’s in progress—no stress, it’ll land soon!`;
  await bot.telegram.sendMessage(userId, msg, { parse_mode: 'Markdown' });

  res.status(200).send('OK');
}

async function handlePaymentOrderExpired(data, res) {
  const { orderId } = data;
  const txSnapshot = await db.collection('transactions')
    .where('paycrestOrderId', '==', orderId)
    .limit(1)
    .get();

  if (txSnapshot.empty) {
    logger.warn(`No transaction found for expired Paycrest order ${orderId}`);
    return res.status(404).send('Transaction not found');
  }

  const txDoc = txSnapshot.docs[0];
  const txData = txDoc.data();
  const userId = txData.userId;
  const userState = await getUserState(userId);
  const blockExplorerUrl = txData.chain === 'Base' ? `https://basescan.org/tx/${txData.transactionHash}` :
                          txData.chain === 'Polygon' ? `https://polygonscan.com/tx/${txData.transactionHash}` :
                          txData.chain === 'BNB Smart Chain' ? `https://bscscan.com/tx/${txData.transactionHash}` : '#';

  await db.collection('transactions').doc(txData.referenceId).update({ status: 'Failed' });

  const msg = userState.usePidgin
    ? `❌ *Transaction Expire*\n\n` +
      `*Ref ID:* \`${txData.referenceId}\`\n` +
      `*Amount:* ${txData.amount} ${txData.asset}\n` +
      `*NGN Value:* ₦${txData.payout}\n` +
      `*Tx Hash:* [${txData.transactionHash}](${blockExplorerUrl})\n` +
      `*Paycrest Order ID:* \`${orderId}\`\n` +
      `*Time:* ${new Date().toLocaleString()}\n\n` +
      `E no work o. Contact [@maxcswap](https://t.me/maxcswap) for help!`
    : `❌ *Transaction Expired*\n\n` +
      `*Reference ID:* \`${txData.referenceId}\`\n` +
      `*Amount:* ${txData.amount} ${txData.asset}\n` +
      `*NGN Value:* ₦${txData.payout}\n` +
      `*Transaction Hash:* [${txData.transactionHash}](${blockExplorerUrl})\n` +
      `*Paycrest Order ID:* \`${orderId}\`\n` +
      `*Time:* ${new Date().toLocaleString()}\n\n` +
      `It failed to process. Contact [@maxcswap](https://t.me/maxcswap) for assistance!`;
  await bot.telegram.sendMessage(userId, msg, { parse_mode: 'Markdown' });

  await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ *Payment Order Expired*\n\n` +
    `*User ID:* ${userId}\n` +
    `*Ref ID:* \`${txData.referenceId}\`\n` +
    `*Amount:* ${txData.amount} ${txData.asset}\n` +
    `*NGN Value:* ₦${txData.payout}\n` +
    `*Tx Hash:* [${txData.transactionHash}](${blockExplorerUrl})\n` +
    `*Paycrest Order ID:* ${orderId}\n` +
    `*Time:* ${new Date().toLocaleString()}\n\n` +
    `Check this transaction!`, { parse_mode: 'Markdown' });

  res.status(200).send('OK');
}

async function handlePaymentOrderSettled(data, res) {
  const { orderId, amountPaid, percentSettled, senderFee, networkFee, updatedAt, recipient, txHash } = data;
  const txSnapshot = await db.collection('transactions')
    .where('paycrestOrderId', '==', orderId)
    .limit(1)
    .get();

  if (txSnapshot.empty) {
    logger.warn(`No transaction found for settled Paycrest order ${orderId}`);
    return res.status(404).send('Transaction not found');
  }

  const txDoc = txSnapshot.docs[0];
  const txData = txDoc.data();
  const userId = txData.userId;
  const userState = await getUserState(userId);
  const blockExplorerUrl = txData.chain === 'Base' ? `https://basescan.org/tx/${txHash}` :
                          txData.chain === 'Polygon' ? `https://polygonscan.com/tx/${txHash}` :
                          txData.chain === 'BNB Smart Chain' ? `https://bscscan.com/tx/${txHash}` : '#';

  await db.collection('transactions').doc(txData.referenceId).update({
    status: 'Completed',
    payout: parseFloat(amountPaid),
    transactionHash: txHash,
    updatedAt: new Date(updatedAt).toISOString()
  });

  const wallet = userState.wallets.find(w => w.address === txData.walletAddress);
  if (wallet) {
    wallet.totalPayouts += parseFloat(amountPaid);
    await updateUserState(userId, { wallets: userState.wallets });
  }

  const msg = userState.usePidgin
    ? `✅ *Payout Complete!*\n\n` +
      `*Ref ID:* \`${txData.referenceId}\`\n` +
      `*Amount:* ${txData.amount} ${txData.asset}\n` +
      `*Paid:* ₦${amountPaid}\n` +
      `*Bank:* ${recipient.institution} (****${recipient.accountIdentifier.slice(-4)})\n` +
      `*Receiver:* ${recipient.accountName}\n` +
      `*Tx Hash:* [${txHash}](${blockExplorerUrl})\n` +
      `*Paycrest Order ID:* \`${orderId}\`\n` +
      `*Time:* ${new Date(updatedAt).toLocaleString()}\n\n` +
      `Money don land your account!`
    : `✅ *Payout Completed!*\n\n` +
      `*Reference ID:* \`${txData.referenceId}\`\n` +
      `*Amount:* ${txData.amount} ${txData.asset}\n` +
      `*Paid:* ₦${amountPaid}\n` +
      `*Bank:* ${recipient.institution} (****${recipient.accountIdentifier.slice(-4)})\n` +
      `*Receiver:* ${recipient.accountName}\n` +
      `*Transaction Hash:* [${txHash}](${blockExplorerUrl})\n` +
      `*Paycrest Order ID:* \`${orderId}\`\n` +
      `*Time:* ${new Date(updatedAt).toLocaleString()}\n\n` +
      `Funds have been credited to your account!`;
  await bot.telegram.sendPhoto(userId, { source: PAYOUT_SUCCESS_IMAGE }, {
    caption: msg,
    parse_mode: 'Markdown'
  });

  await bot.telegram.sendPhoto(PERSONAL_CHAT_ID, { source: PAYOUT_SUCCESS_IMAGE }, {
    caption: `✅ *Payout Completed*\n\n` +
      `*User ID:* ${userId}\n` +
      `*First Name:* ${userState.firstName || 'Unknown'}\n` +
      `*Amount:* ${txData.amount} ${txData.asset}\n` +
      `*Paid:* ₦${amountPaid}\n` +
      `*Percent Settled:* ${percentSettled}%\n` +
      `*Sender Fee:* ₦${senderFee}\n` +
      `*Network Fee:* ₦${networkFee}\n` +
      `*Tx Hash:* [${txHash}](${blockExplorerUrl})\n` +
      `*Bank:* ${recipient.institution}\n` +
      `*Account Number:* ${recipient.accountIdentifier}\n` +
      `*Receiver:* ${recipient.accountName}\n` +
      `*Paycrest Order ID:* ${orderId}\n` +
      `*Time:* ${new Date(updatedAt).toLocaleString()}`,
    parse_mode: 'Markdown'
  });

  res.status(200).send('OK');
}

async function handlePaymentOrderRefunded(data, res) {
  const { orderId, refundAddress: paycrestRefundAddress } = data;
  const txSnapshot = await db.collection('transactions')
    .where('paycrestOrderId', '==', orderId)
    .limit(1)
    .get();

  if (txSnapshot.empty) {
    logger.warn(`No transaction found for refunded Paycrest order ${orderId}`);
    return res.status(404).send('Transaction not found');
  }

  const txDoc = txSnapshot.docs[0];
  const txData = txDoc.data();
  const userId = txData.userId;
  const userState = await getUserState(userId);
  const finalRefundAddress = userState.refundAddress || txData.senderAddress || paycrestRefundAddress || txData.walletAddress;
  const blockExplorerUrl = txData.chain === 'Base' ? `https://basescan.org/tx/${txData.transactionHash}` :
                          txData.chain === 'Polygon' ? `https://polygonscan.com/tx/${txData.transactionHash}` :
                          txData.chain === 'BNB Smart Chain' ? `https://bscscan.com/tx/${txData.transactionHash}` : '#';

  await db.collection('transactions').doc(txData.referenceId).update({
    status: 'Refunded',
    refundAddress: finalRefundAddress,
    updatedAt: new Date().toISOString()
  });

  const warningMsg = !userState.refundAddress
    ? userState.usePidgin
      ? `\n\n⚠️ *Warning:* You no set refund address, so we use sender address (\`${finalRefundAddress}\`). If e no be your own, funds fit lost. Set one for "⚙️ Settings" > "🔙 Set Refund Address"!`
      : `\n\n⚠️ *Warning:* You haven’t set a refund address, so we used the sender’s address (\`${finalRefundAddress}\`). If it’s not yours, funds may be lost. Set one in "⚙️ Settings" > "🔙 Set Refund Address"!`
    : '';

  const msg = userState.usePidgin
    ? `🔄 *Transaction Refunded*\n\n` +
      `*Ref ID:* \`${txData.referenceId}\`\n` +
      `*Amount:* ${txData.amount} ${txData.asset}\n` +
      `*Refunded To:* \`${finalRefundAddress}\`\n` +
      `*Tx Hash:* [${txData.transactionHash}](${blockExplorerUrl})\n` +
      `*Paycrest Order ID:* \`${orderId}\`\n` +
      `*Time:* ${new Date().toLocaleString()}\n\n` +
      `We don send your funds back. Check your wallet!${warningMsg}`
    : `🔄 *Transaction Refunded*\n\n` +
      `*Reference ID:* \`${txData.referenceId}\`\n` +
      `*Amount:* ${txData.amount} ${txData.asset}\n` +
      `*Refunded To:* \`${finalRefundAddress}\`\n` +
      `*Transaction Hash:* [${txData.transactionHash}](${blockExplorerUrl})\n` +
      `*Paycrest Order ID:* \`${orderId}\`\n` +
      `*Time:* ${new Date().toLocaleString()}\n\n` +
      `Your funds have been refunded. Check your wallet!${warningMsg}`;
  await bot.telegram.sendMessage(userId, msg, { parse_mode: 'Markdown' });

  await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🔄 *Transaction Refunded*\n\n` +
    `*User ID:* ${userId}\n` +
    `*Ref ID:* \`${txData.referenceId}\`\n` +
    `*Amount:* ${txData.amount} ${txData.asset}\n` +
    `*Refunded To:* \`${finalRefundAddress}\`\n` +
    `*Tx Hash:* [${txData.transactionHash}](${blockExplorerUrl})\n` +
    `*Paycrest Order ID:* ${orderId}\n` +
    `*Time:* ${new Date().toLocaleString()}\n` +
    (!userState.refundAddress ? `*Note:* No refund address set, used sender address.` : ''), { parse_mode: 'Markdown' });

  res.status(200).send('OK');
}

// =================== Keep-Alive Cron Job ===================
async function keepAlive() {
  try {
    await bot.telegram.getMe();
    logger.info('Keep-alive ping successful');
  } catch (error) {
    logger.error(`Keep-alive ping failed: ${error.message}`);
  }
}

const keepAliveJob = new cron.CronJob('*/10 * * * *', keepAlive, null, true, 'UTC');
keepAliveJob.start();
logger.info('Keep-alive cron job started, running every 10 minutes');

// =================== Start Server ===================
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});

// =================== Error Handling ===================
bot.catch((err, ctx) => {
  logger.error(`Bot error: ${err.message}`, { stack: err.stack, update: ctx.update });
  ctx.replyWithMarkdown('❌ An error occurred. We’re looking into it!');
});


module.exports = app;
