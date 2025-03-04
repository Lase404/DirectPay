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
// Simple Levenshtein distance function for fuzzy matching
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

  // Suggest if distance is low but not exact match (e.g., <= 3)
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

    if (!bank || distance > 3) { // Threshold for no match
      const errorMsg = userState.usePidgin
        ? `❌ Bank name no match o. Check your spelling or try:\n\n${bankList.map(b => `• ${b.name}`).join('\n')}`
        : `❌ No matching bank found. Check your spelling or try:\n\n${bankList.map(b => `• ${b.name}`).join('\n')}`;
      await ctx.replyWithMarkdown(errorMsg);
      return; // Stay on the same step
    }

    if (distance > 0 && distance <= 3) { // Suggest close match
      const confirmMsg = userState.usePidgin
        ? `You mean *${bank.name}*? You type "${input}".\n\nCorrect?`
        : `Did you mean *${bank.name}*? You entered "${input}".\n\nIs this correct?`;
      ctx.session.bankData.suggestedBank = bank;
      const sentMessage = await ctx.replyWithMarkdown(confirmMsg, Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes', 'confirm_suggested_bank')],
        [Markup.button.callback('❌ No', 'retry_bank_name')]
      ]));
      ctx.session.suggestionMessageId = sentMessage.message_id; // Store message ID for deletion
      return; // Wait for confirmation
    }

    // Exact match found
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
      return; // Stay on the same step
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

  // Delete the suggestion message if it exists
  if (ctx.session.suggestionMessageId) {
    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, ctx.session.suggestionMessageId);
      delete ctx.session.suggestionMessageId; // Clear the stored ID
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
app.use(bodyParser.json());
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
setInterval(fetchExchangeRates, 300000); // 5 minutes

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
    const totalPages = Math.max(1, Math.ceil(userState.wallets.length / pageSize)); // Ensure at least 1 page
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
    ctx.session.walletMessageId = sentMessage.message_id; // Store message ID for editing
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
  const learnMsg = userState.usePidgin
    ? '📘 *Wetin Be Base?*\n\nBase na fast, cheap Ethereum Layer 2 chain. E dey use USDC/USDT, so you fit send money quick and save gas fees. Na Coinbase build am, so e solid!'
    : '📘 *What is Base?*\n\nBase is a fast, low-cost Ethereum Layer 2 chain. It supports USDC/USDT, letting you send money quickly while saving on gas fees. Built by Coinbase, it’s reliable!';
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
    ? '\nThese rates go work for your deposits and payouts.'
    : '\nThese rates apply to your deposits and payouts.';
  await ctx.replyWithMarkdown(ratesMessage);
});

// =================== Settings Handler ===================
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
      // Existing generate_wallet logic (already updated in previous response)
      const userId = ctx.from.id.toString();
      try {
        let userState = await getUserState(userId);

        if (userState.wallets.length >= MAX_WALLETS) {
          const errorMsg = userState.usePidgin
            ? `⚠️ You don reach max wallets (${MAX_WALLETS}). Check your wallets first.`
            : `⚠️ You’ve reached the max wallet limit (${MAX_WALLETS}). Check your existing wallets first.`;
          await ctx.replyWithMarkdown(errorMsg);
          return ctx.answerCbQuery();
        }

        await ctx.replyWithMarkdown(userState.usePidgin
          ? '💼 *Make New Wallet*\n\nE go land on Base soon:'
          : '💼 *Create a New Wallet*\n\nIt’ll be on Base shortly:');

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
        logger.error(`Error handling Generate Wallet from settings for user ${userId}: ${error.message}`);
        const userState = await getUserState(userId);
        const errorMsg = userState.usePidgin
          ? '❌ E no work. Try again later.'
          : '❌ It didn’t work. Try again later.';
        await ctx.replyWithMarkdown(errorMsg);
      }
      break;

    case 'edit_bank':
      if (userState.wallets.length === 0) {
        await ctx.replyWithMarkdown(userState.usePidgin
          ? '❌ No wallet dey. Generate one first.'
          : '❌ No wallets yet. Generate one first.');
        return;
      }
      let keyboard = userState.wallets.map((wallet, index) => [
        Markup.button.callback(`Wallet ${index + 1} - ${wallet.chain} ${wallet.bank ? '(Linked)' : ''}`, `select_wallet_edit_bank_${index}`)
      ]);
      await ctx.replyWithMarkdown(userState.usePidgin
        ? '✏️ Pick wallet to edit bank:'
        : '✏️ Select a wallet to edit bank details:', Markup.inlineKeyboard(keyboard));
      break;

    case 'rename_wallet':
      if (userState.wallets.length === 0) {
        await ctx.replyWithMarkdown(userState.usePidgin
          ? '❌ No wallet to rename. Generate one first.'
          : '❌ No wallets to rename. Generate one first.');
        return;
      }
      let renameKeyboard = userState.wallets.map((wallet, index) => [
        Markup.button.callback(`Wallet ${index + 1} - ${wallet.chain}`, `select_wallet_rename_${index}`)
      ]);
      await ctx.replyWithMarkdown(userState.usePidgin
        ? '📝 Pick wallet to rename:'
        : '📝 Select a wallet to rename:', Markup.inlineKeyboard(renameKeyboard));
      break;

    case 'support':
      await ctx.replyWithMarkdown(userState.usePidgin
        ? '🛠️ *Support*\n\nWetin you need?'
        : '🛠️ *Support*\n\nHow can we help?', Markup.inlineKeyboard([
          [Markup.button.callback('❓ How It Works', 'support_how_it_works')],
          [Markup.button.callback('⚠️ Transaction Not Received', 'support_not_received')],
          [Markup.button.callback('💬 Contact Support', 'support_contact')],
        ]));
      break;

    case 'back_main':
      await greetUser(ctx);
      break;

    default:
      await ctx.answerCbQuery('⚠️ Option no dey.');
  }
  await ctx.answerCbQuery();
});


// =================== Additional Action Handlers ===================
bot.action(/select_wallet_edit_bank_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);

  if (isNaN(walletIndex)) {
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '⚠️ Wallet no correct. Try again.'
      : '⚠️ Invalid wallet selection. Please try again.';
    await ctx.replyWithMarkdown(errorMsg);
    return ctx.answerCbQuery();
  }

  ctx.session.walletIndex = walletIndex;
  await ctx.scene.enter('bank_linking_scene');
  ctx.answerCbQuery();
});

bot.action(/select_receipt_wallet_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);

  if (isNaN(walletIndex)) {
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '⚠️ Wallet no correct. Try again.'
      : '⚠️ Invalid wallet selection. Please try again.';
    await ctx.replyWithMarkdown(errorMsg);
    return ctx.answerCbQuery();
  }

  ctx.session.walletIndex = walletIndex;
  await ctx.scene.enter('receipt_generation_scene');
  ctx.answerCbQuery();
});

bot.action(/select_wallet_rename_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);
  const userState = await getUserState(userId);

  if (isNaN(walletIndex) || !userState.wallets[walletIndex]) {
    await ctx.replyWithMarkdown(userState.usePidgin
      ? '❌ Wallet no correct. Try again.'
      : '❌ Invalid wallet selection. Try again.');
    return ctx.answerCbQuery();
  }

  ctx.session.awaitingRename = walletIndex;
  await ctx.replyWithMarkdown(userState.usePidgin
    ? `📝 Wetin you wan call Wallet ${walletIndex + 1} (${userState.wallets[walletIndex].chain})?`
    : `📝 What do you want to name Wallet ${walletIndex + 1} (${userState.wallets[walletIndex].chain})?`);
  await ctx.answerCbQuery();
});

bot.action(/export_receipt_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);
  const userState = await getUserState(userId);

  try {
    const wallet = userState.wallets[walletIndex];
    if (!wallet) throw new Error('Wallet not found.');

    const transactionsSnapshot = await db.collection('transactions')
      .where('walletAddress', '==', wallet.address)
      .orderBy('timestamp', 'desc')
      .limit(10)
      .get();

    if (transactionsSnapshot.empty) {
      await ctx.replyWithMarkdown(userState.usePidgin
        ? 'No transactions for this wallet yet.'
        : 'No transactions found for this wallet yet.');
      return ctx.answerCbQuery();
    }

    let receiptMessage = userState.usePidgin
      ? `🧾 Receipt for Wallet ${walletIndex + 1} - ${wallet.chain}\n\n`
      : `🧾 Transaction Receipt for Wallet ${walletIndex + 1} - ${wallet.chain}\n\n`;
    transactionsSnapshot.forEach((doc) => {
      const tx = doc.data();
      receiptMessage += `Transaction ${tx.referenceId || 'N/A'}:\n`;
      receiptMessage += `Ref ID: ${tx.referenceId || 'N/A'}\n`;
      receiptMessage += `Amount: ${tx.amount || 'N/A'} ${tx.asset || 'N/A'}\n`;
      receiptMessage += `Status: ${tx.status || 'Pending'}\n`;
      receiptMessage += `Rate: ₦${exchangeRates[tx.asset] || 'N/A'} per ${tx.asset || 'N/A'}\n`;
      receiptMessage += `Date: ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n`;
      receiptMessage += `Chain: ${tx.chain || 'N/A'}\n\n`;
    });

    const filePath = path.join(__dirname, `receipt_${userId}_${walletIndex}.txt`);
    fs.writeFileSync(filePath, receiptMessage);
    await ctx.replyWithDocument({ source: createReadStream(filePath), filename: `Receipt_Wallet_${walletIndex + 1}.txt` });
    fs.unlinkSync(filePath);

    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error exporting receipt for user ${userId}: ${error.message}`);
    const errorMsg = userState.usePidgin
      ? '❌ Error exporting receipt. Try again later.'
      : '❌ Error exporting receipt. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    ctx.answerCbQuery();
  }
});

// =================== Bank Linking Action Handlers ===================
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

// =================== Text Input Handler ===================
bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  let userState;

  try {
    userState = await getUserState(userId);
  } catch (error) {
    logger.error(`Failed to get user state in text handler for ${userId}: ${error.message}`);
    const errorMsg = userState.usePidgin
      ? '❌ Problem dey. Try again later.'
      : '❌ Error occurred. Try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    return;
  }

  if (ctx.message.text.toLowerCase() === 'pidgin') {
    await updateUserState(userId, { usePidgin: true });
    const confirmMsg = userState.usePidgin
      ? `We don switch to Pidgin for you, ${userState.firstName || 'friend'}!`
      : `We’ve switched to Pidgin for you, ${userState.firstName || 'user'}!`;
    await ctx.replyWithMarkdown(confirmMsg);
    return;
  }

  if (ctx.session.awaitingRename !== undefined) {
    try {
      const walletIndex = ctx.session.awaitingRename;
      const newName = ctx.message.text.trim();

      if (walletIndex < 0 || walletIndex >= userState.wallets.length) {
        const errorMsg = userState.usePidgin
          ? '❌ Wallet no dey. Try again.'
          : '❌ Invalid wallet. Try again.';
        await ctx.replyWithMarkdown(errorMsg);
        delete ctx.session.awaitingRename;
        return;
      }

      if (!newName) {
        const errorMsg = userState.usePidgin
          ? '❌ Name no fit empty. Enter something.'
          : '❌ Name cannot be empty. Enter a valid name.';
        await ctx.replyWithMarkdown(errorMsg);
        return;
      }

      userState.wallets[walletIndex].name = newName;
      await updateUserState(userId, { wallets: userState.wallets });

      const successMsg = userState.usePidgin
        ? `✅ Wallet now called "${newName}".`
        : `✅ Wallet renamed to "${newName}".`;
      await ctx.replyWithMarkdown(successMsg);
      delete ctx.session.awaitingRename;
    } catch (error) {
      logger.error(`Error renaming wallet for user ${userId}: ${error.message}`);
      const errorMsg = userState.usePidgin
        ? '❌ Problem renaming. Try again.'
        : '❌ Error renaming wallet. Try again.';
      await ctx.replyWithMarkdown(errorMsg);
      delete ctx.session.awaitingRename;
    }
  }

  if (ctx.session.awaitingBroadcastMessage) {
    try {
      if (!isAdmin(userId)) {
        const errorMsg = userState.usePidgin
          ? '❌ Only admin fit do this.'
          : '❌ Admin access only.';
        await ctx.replyWithMarkdown(errorMsg);
        await updateUserState(userId, { awaitingBroadcastMessage: false });
        return;
      }

      const messageContent = ctx.message.text.trim();
      const photo = ctx.message.photo;

      const usersSnapshot = await db.collection('users').get();
      if (usersSnapshot.empty) {
        const errorMsg = userState.usePidgin
          ? '❌ No users to send message to.'
          : '❌ No users found to broadcast to.';
        await ctx.replyWithMarkdown(errorMsg);
        ctx.session.awaitingBroadcastMessage = false;
        return;
      }

      const sendPromises = [];
      usersSnapshot.forEach((doc) => {
        const userTelegramId = doc.id;
        if (photo) {
          const highestResolutionPhoto = photo[photo.length - 1];
          const fileId = highestResolutionPhoto.file_id;
          const caption = ctx.message.caption || '';
          sendPromises.push(bot.telegram.sendPhoto(userTelegramId, fileId, { caption: caption, parse_mode: 'Markdown' }));
        } else if (messageContent) {
          sendPromises.push(bot.telegram.sendMessage(userTelegramId, `📢 *Admin Broadcast:*\n\n${messageContent}`, { parse_mode: 'Markdown' }));
        }
      });

      await Promise.all(sendPromises);
      const successMsg = userState.usePidgin
        ? '✅ Message don reach all users.'
        : '✅ Broadcast sent to all users.';
      await ctx.replyWithMarkdown(successMsg);
      logger.info(`Admin ${userId} sent broadcast to all users.`);
      await updateUserState(userId, { awaitingBroadcastMessage: false });
    } catch (error) {
      logger.error(`Error broadcasting message: ${error.message}`);
      const errorMsg = userState.usePidgin
        ? '❌ Problem sending message. Try again.'
        : '❌ Error sending broadcast. Try again later.';
      await ctx.replyWithMarkdown(errorMsg);
      await updateUserState(userId, { awaitingBroadcastMessage: false });
    }
  }
});

// =================== Admin Panel Handlers ===================
bot.action('open_admin_panel', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) return ctx.reply('❌ No access.');

  await ctx.editMessageText('🔧 *Admin Control Hub*\n\nWhat you wan handle?', {
    parse_mode: 'Markdown',
    reply_markup: getAdminMenu().reply_markup
  });
});

bot.action('admin_view_all_transactions', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) return ctx.reply('❌ No access.');

  const userState = await getUserState(userId);
  const prompt = userState.usePidgin
    ? '📋 *All Transactions*\n\nPick filter to see:'
    : '📋 *All Transactions*\n\nChoose a filter to view:';

  await ctx.editMessageText(prompt, {
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback('📋 All Transactions', 'admin_tx_all')],
      [Markup.button.callback('✅ Completed', 'admin_tx_status_Completed')],
      [Markup.button.callback('❌ Failed', 'admin_tx_status_Failed')],
      [Markup.button.callback('⏳ Pending', 'admin_tx_status_Pending')],
      [Markup.button.callback('🔄 Refunded', 'admin_tx_status_Refunded')],
      [Markup.button.callback('🪙 By Asset', 'admin_tx_filter_asset')],
      [Markup.button.callback('🔙 Back', 'open_admin_panel')]
    ]).reply_markup
  });
});

async function displayAdminTransactions(ctx, query, page = 1, filterDescription = '') {
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
    ? `📋 *Admin - Transactions*${filterDescription} (Page ${page}/${totalPages})\n*Updated:* ${timestamp}\n\n`
    : `📋 *Admin - Transactions*${filterDescription} (Page ${page}/${totalPages})\n*Updated:* ${timestamp}\n\n`;

  if (transactionsSnapshot.empty) {
    message += userState.usePidgin ? 'No transactions dey yet.' : 'No transactions found yet.';
  } else {
    transactionsSnapshot.forEach((doc) => {
      const tx = doc.data();
      message += `*User:* ${tx.userId}\n` +
                 `*Ref ID:* \`${tx.referenceId || 'N/A'}\`\n` +
                 `*Asset:* ${tx.asset || 'N/A'}\n` +
                 `*Amount:* ${tx.amount || 'N/A'}\n` +
                 `*Payout:* ₦${tx.payout || 'N/A'}\n` +
                 `*Status:* ${tx.status || 'Pending'}\n` +
                 `*Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleDateString() : 'N/A'}\n` +
                 `*Chain:* ${tx.chain || 'N/A'}\n` +
                 (tx.status === 'Completed'
                   ? `*Tx Hash:* \`${tx.transactionHash || 'N/A'}\`\n` +
                     `*Paid To:* ${tx.bankDetails?.bankName || 'N/A'} (****${tx.bankDetails?.accountNumber?.slice(-4) || 'N/A'})\n`
                   : '') +
                 `\n`;
    });
  }

  const navigationButtons = [];
  if (page > 1) navigationButtons.push(Markup.button.callback('⬅️ Previous', `admin_tx_page_${page - 1}_${filterDescription.replace(/\s/g, '_')}`));
  if (page < totalPages) navigationButtons.push(Markup.button.callback('Next ➡️', `admin_tx_page_${page + 1}_${filterDescription.replace(/\s/g, '_')}`));
  navigationButtons.push(Markup.button.callback('🔄 Refresh', `admin_tx_page_${page}_${filterDescription.replace(/\s/g, '_')}`));
  navigationButtons.push(Markup.button.callback('🔙 Back to Filters', 'admin_tx_back'));

  const inlineKeyboard = Markup.inlineKeyboard([navigationButtons]);
  await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: inlineKeyboard.reply_markup });
}

bot.action('admin_tx_all', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) return ctx.reply('❌ No access.');
  try {
    const query = db.collection('transactions').orderBy('timestamp', 'desc');
    await displayAdminTransactions(ctx, query, 1, ' - All Transactions');
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error displaying all admin transactions for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('❌ Error dey. Try again later.');
    ctx.answerCbQuery();
  }
});

bot.action(/admin_tx_status_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) return ctx.reply('❌ No access.');
  const status = ctx.match[1];
  try {
    const query = db.collection('transactions')
      .where('status', '==', status)
      .orderBy('timestamp', 'desc');
    await displayAdminTransactions(ctx, query, 1, ` - ${status} Transactions`);
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error displaying ${status} admin transactions for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('❌ Error dey. Try again later.');
    ctx.answerCbQuery();
  }
});

bot.action('admin_tx_filter_asset', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) return ctx.reply('❌ No access.');
  const userState = await getUserState(userId);
  const prompt = userState.usePidgin
    ? '🪙 Pick asset to filter transactions:'
    : '🪙 Select asset to filter transactions:';
  await ctx.editMessageText(prompt, {
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback('USDC', 'admin_tx_asset_USDC')],
      [Markup.button.callback('USDT', 'admin_tx_asset_USDT')],
      [Markup.button.callback('🔙 Back', 'admin_tx_back')]
    ]).reply_markup
  });
  ctx.answerCbQuery();
});

bot.action(/admin_tx_asset_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) return ctx.reply('❌ No access.');
  const asset = ctx.match[1];
  try {
    const query = db.collection('transactions')
      .where('asset', '==', asset)
      .orderBy('timestamp', 'desc');
    await displayAdminTransactions(ctx, query, 1, ` - ${asset} Transactions`);
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error displaying ${asset} admin transactions for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('❌ Error dey. Try again later.');
    ctx.answerCbQuery();
  }
});

bot.action(/admin_tx_page_(\d+)_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) return ctx.reply('❌ No access.');
  const page = parseInt(ctx.match[1], 10);
  const filterDescription = ctx.match[2].replace(/_/g, ' ');

  try {
    let query = db.collection('transactions')
      .orderBy('timestamp', 'desc');

    if (filterDescription.includes('Completed') || filterDescription.includes('Failed') || 
        filterDescription.includes('Pending') || filterDescription.includes('Refunded')) {
      const status = filterDescription.split(' - ')[1].replace(' Transactions', '');
      query = query.where('status', '==', status);
    } else if (filterDescription.includes('USDC') || filterDescription.includes('USDT')) {
      const asset = filterDescription.split(' - ')[1].replace(' Transactions', '');
      query = query.where('asset', '==', asset);
    }

    await displayAdminTransactions(ctx, query, page, filterDescription);
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error navigating admin transaction page for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('❌ Error dey. Try again later.');
    ctx.answerCbQuery();
  }
});

bot.action('admin_tx_back', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) return ctx.reply('❌ No access.');
  const userState = await getUserState(userId);
  const prompt = userState.usePidgin
    ? '📋 *All Transactions*\n\nPick filter to see:'
    : '📋 *All Transactions*\n\nChoose a filter to view:';

  await ctx.editMessageText(prompt, {
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback('📋 All Transactions', 'admin_tx_all')],
      [Markup.button.callback('✅ Completed', 'admin_tx_status_Completed')],
      [Markup.button.callback('❌ Failed', 'admin_tx_status_Failed')],
      [Markup.button.callback('⏳ Pending', 'admin_tx_status_Pending')],
      [Markup.button.callback('🔄 Refunded', 'admin_tx_status_Refunded')],
      [Markup.button.callback('🪙 By Asset', 'admin_tx_filter_asset')],
      [Markup.button.callback('🔙 Back', 'open_admin_panel')]
    ]).reply_markup
  });
  ctx.answerCbQuery();
});



bot.action('admin_view_users', async (ctx) => {
  const usersSnapshot = await db.collection('users').get();
  let msg = '👥 *All Users*\n\n';
  usersSnapshot.forEach(doc => {
    const user = doc.data();
    msg += `*ID:* ${doc.id}\n*Name:* ${user.firstName}\n*Wallets:* ${user.wallets.length}\n\n`;
  });
  await ctx.editMessageText(msg, { parse_mode: 'Markdown', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'open_admin_panel')]]).reply_markup });
});

bot.action('admin_pending_issues', async (ctx) => {
  const pendingSnapshot = await db.collection('transactions').where('status', 'in', ['Pending', 'Received']).get();
  let msg = '⏳ *Pending Issues*\n\n';
  pendingSnapshot.forEach(doc => {
    const tx = doc.data();
    msg += `*User:* ${tx.userId}\n*Ref ID:* ${tx.referenceId}\n*Status:* ${tx.status}\n*Amount:* ${tx.amount} ${tx.asset}\n\n`;
  });
  await ctx.editMessageText(msg, { parse_mode: 'Markdown', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'open_admin_panel')]]).reply_markup });
});

bot.action('admin_send_message', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) return ctx.reply('❌ No access.');
  await ctx.scene.enter('send_message_scene');
  ctx.answerCbQuery();
});

bot.action('admin_manual_payout', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) return ctx.reply('❌ No access.');
  await ctx.reply('💰 Enter transaction Ref ID for manual payout:');
  // Implement manual payout logic here if needed
  ctx.answerCbQuery();
});

bot.action('admin_refund_tx', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) return ctx.reply('❌ No access.');
  await ctx.reply('🔄 Enter transaction Ref ID to refund:');
  // Implement refund logic here if needed
  ctx.answerCbQuery();
});

bot.action('admin_api_status', async (ctx) => {
  const statusMsg = '⚠️ *API/Bot Status*\n\n' +
    `*Paycrest:* ${exchangeRates.USDC ? '✅ Online' : '❌ Offline'}\n` +
    `*Blockradar:* ${chains.Base.key ? '✅ Online' : '❌ Offline'}\n` +
    `*Bot:* Running fine\n`;
  await ctx.editMessageText(statusMsg, { parse_mode: 'Markdown', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'open_admin_panel')]]).reply_markup });
});

bot.action('admin_back_to_main', async (ctx) => {
  await greetUser(ctx);
  ctx.answerCbQuery();
});

// =================== Feedback Handler ===================
bot.action(/feedback_(.+)_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const referenceId = ctx.match[1];
  const rating = ctx.match[2];
  const userState = await getUserState(userId);

  const txDoc = await db.collection('transactions').where('referenceId', '==', referenceId).get();
  if (!txDoc.empty) {
    await txDoc.docs[0].ref.update({ feedback: rating });
    await ctx.replyWithMarkdown(userState.usePidgin
      ? `Thanks for feedback! We go improve if e no good.`
      : `Thanks for your feedback! We’ll improve if it wasn’t great.`);
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `📝 *Feedback*\n\n*User:* ${userId}\n*Ref ID:* ${referenceId}\n*Rating:* ${rating}`, { parse_mode: 'Markdown' });
  }
  await ctx.answerCbQuery();
});

// =================== Paycrest Webhook Handler ===================
app.post(WEBHOOK_PAYCREST_PATH, bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-paycrest-signature'];
  const rawBody = req.body;
  const clientIp = req.clientIp;

  if (!signature) {
    logger.error(`No Paycrest signature found in headers from IP: ${clientIp}`);
    return res.status(400).send('Signature missing.');
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

  const event = parsedBody.event;
  const data = parsedBody.data;

  if (!event || !data) {
    logger.error(`Missing event or data in Paycrest webhook from IP: ${clientIp}`);
    return res.status(400).send('Invalid webhook payload.');
  }

  const eventType = event;
  logger.info(`Received Paycrest event: ${eventType} from IP: ${clientIp}`);

  switch (eventType) {
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
      logger.warn(`Unhandled Paycrest webhook event type: ${eventType} from IP: ${clientIp}`);
      res.status(200).send('OK');
  }
});

async function handlePaymentOrderPending(data, res) {
  const orderId = data.id;
  const amount = parseFloat(data.amount) || 0;
  const reference = data.reference;

  try {
    const txSnapshot = await db.collection('transactions').where('paycrestOrderId', '==', orderId).get();
    if (txSnapshot.empty) {
      logger.error(`No transaction found for Paycrest orderId: ${orderId}`);
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ No transaction for Paycrest orderId: \`${orderId}\``);
      return res.status(200).send('OK');
    }

    const txDoc = txSnapshot.docs[0];
    const txData = txDoc.data();
    const userId = txData.userId;

    await db.collection('transactions').doc(txDoc.id).update({ status: 'Pending' });

    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🔄 *Payment Order Pending*\n\n*User:* ${userId}\n*Ref ID:* ${reference}\n*Amount:* ${amount} ${txData.asset}`, { parse_mode: 'Markdown' });

    res.status(200).send('OK');
  } catch (error) {
    logger.error(`Error handling payment_order.pending for orderId ${orderId}: ${error.message}`);
    res.status(500).send('Error');
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error in pending order ${orderId}: ${error.message}`);
  }
}

async function handlePaymentOrderExpired(data, res) {
  const orderId = data.id;
  const reference = data.reference;

  try {
    const txSnapshot = await db.collection('transactions').where('paycrestOrderId', '==', orderId).get();
    if (txSnapshot.empty) {
      logger.error(`No transaction found for Paycrest orderId: ${orderId}`);
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ No transaction for Paycrest orderId: \`${orderId}\``);
      return res.status(200).send('OK');
    }

    const txDoc = txSnapshot.docs[0];
    const txData = txDoc.data();
    const userId = txData.userId;

    if (txData.status === 'Expired') {
      logger.info(`Transaction ${orderId} already expired.`);
      return res.status(200).send('OK');
    }

    await db.collection('transactions').doc(txDoc.id).update({ status: 'Expired' });

    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⏰ *Payment Order Expired*\n\n*User:* ${userId}\n*Ref ID:* ${reference}`, { parse_mode: 'Markdown' });

    res.status(200).send('OK');
  } catch (error) {
    logger.error(`Error handling payment_order.expired for orderId ${orderId}: ${error.message}`);
    res.status(500).send('Error');
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error in expired order ${orderId}: ${error.message}`);
  }
}

async function handlePaymentOrderSettled(data, res) {
  const orderId = data.id;
  const amountPaid = parseFloat(data.amountPaid) || 0;
  const txHash = data.txHash;
  const reference = data.reference;
  const recipient = data.recipient;
  const percentSettled = parseFloat(data.percentSettled) || 0;
  const senderFee = parseFloat(data.senderFee) || 0;
  const networkFee = parseFloat(data.networkFee) || 0;
  const rate = parseFloat(data.rate) || 0;
  const network = data.network;
  const createdAt = data.createdAt;
  const updatedAt = data.updatedAt;

  try {
    const txSnapshot = await db.collection('transactions').where('paycrestOrderId', '==', orderId).get();
    if (txSnapshot.empty) {
      logger.error(`No transaction found for Paycrest orderId: ${orderId}`);
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ No transaction for Paycrest orderId: \`${orderId}\``);
      return res.status(200).send('OK');
    }

    const txDoc = txSnapshot.docs[0];
    const txData = txDoc.data();
    const userId = txData.userId;
    const userState = await getUserState(userId);

    if (txData.status === 'Paid' || txData.status === 'Completed') {
      logger.info(`Transaction ${orderId} already processed.`);
      return res.status(200).send('OK');
    }

    await db.collection('transactions').doc(txDoc.id).update({
      status: 'Paid',
      txHash: txHash,
      bankDetails: {
        bankName: recipient.institution,
        accountNumber: recipient.accountIdentifier,
        accountName: recipient.accountName
      },
      payout: amountPaid
    });

    const successMsg = userState.usePidgin
      ? `✅ *Payout Done*\n\n` +
        `*Your Deposit:*\n` +
        `• *Amount Sent:* ${txData.amount} ${txData.asset}\n` +
        `• *From Address:* \`${txData.walletAddress}\`\n` +
        `*Payout Details:*\n` +
        `• *Amount Paid:* ₦${amountPaid}\n` +
        `• *Percent Settled:* ${percentSettled}%\n` +
        `• *Sender Fee:* ₦${senderFee}\n` +
        `• *Network Fee:* ₦${networkFee}\n` +
        `• *Exchange Rate:* ₦${rate} per ${txData.asset}\n` +
        `• *Network:* ${network}\n` +
        `• *Transaction Hash:* \`${txHash}\`\n` +
        `• *Paid To:* ${recipient.institution} (****${recipient.accountIdentifier.slice(-4)})\n` +
        `• *Account Name:* ${recipient.accountName}\n` +
        `• *Created:* ${new Date(createdAt).toLocaleString()}\n` +
        `• *Updated:* ${new Date(updatedAt).toLocaleString()}\n\n` +
        `Money don enter your bank.`
      : `✅ *Payout Complete*\n\n` +
        `*Your Deposit:*\n` +
        `• *Amount Sent:* ${txData.amount} ${txData.asset}\n` +
        `• *From Address:* \`${txData.walletAddress}\`\n` +
        `*Payout Details:*\n` +
        `• *Amount Paid:* ₦${amountPaid}\n` +
        `• *Percent Settled:* ${percentSettled}%\n` +
        `• *Sender Fee:* ₦${senderFee}\n` +
        `• *Network Fee:* ₦${networkFee}\n` +
        `• *Exchange Rate:* ₦${rate} per ${txData.asset}\n` +
        `• *Network:* ${network}\n` +
        `• *Transaction Hash:* \`${txHash}\`\n` +
        `• *Paid To:* ${recipient.institution} (****${recipient.accountIdentifier.slice(-4)})\n` +
        `• *Account Name:* ${recipient.accountName}\n` +
        `• *Created:* ${new Date(createdAt).toLocaleString()}\n` +
        `• *Updated:* ${new Date(updatedAt).toLocaleString()}\n\n` +
        `Funds are now in your bank.`;
    await bot.telegram.sendPhoto(userId, { source: PAYOUT_SUCCESS_IMAGE }, {
      caption: successMsg,
      parse_mode: 'Markdown',
    });

    if (txData.messageId) {
      await bot.telegram.editMessageText(userId, txData.messageId, null, successMsg, { parse_mode: 'Markdown' });
      await db.collection('transactions').doc(txDoc.id).update({ status: 'Completed' });

      const feedbackMsg = userState.usePidgin
        ? `₦${amountPaid} don land your bank. How you see am?`
        : `₦${amountPaid} has reached your bank. How was it?`;
      await bot.telegram.sendMessage(userId, feedbackMsg, {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('👍 Good', `feedback_${txData.referenceId}_good`),
           Markup.button.callback('👎 Bad', `feedback_${txData.referenceId}_bad`)]
        ]).reply_markup
      });
      await txDoc.ref.update({ feedbackRequested: true });
    }

    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `✅ *Payment Completed*\n\n*User ID:* ${userId}\n*Ref ID:* ${reference}\n*Amount:* ${txData.amount} ${txData.asset}\n*Paid:* ₦${amountPaid}\n*Tx Hash:* \`${txHash}\`\n*Bank:* ${recipient.institution}\n*Account:* ****${recipient.accountIdentifier.slice(-4)}`, { parse_mode: 'Markdown' });

    res.status(200).send('OK');
  } catch (error) {
    logger.error(`Error processing Paycrest webhook for orderId ${orderId}: ${error.message}`);
    res.status(500).send('Error');
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error processing Paycrest webhook for orderId ${orderId}: ${error.message}`);
  }
}

async function handlePaymentOrderRefunded(data, res) {
  const orderId = data.id;
  const amountReturned = parseFloat(data.amountReturned) || 0;
  const reference = data.reference;

  try {
    const txSnapshot = await db.collection('transactions').where('paycrestOrderId', '==', orderId).get();
    if (txSnapshot.empty) {
      logger.error(`No transaction found for Paycrest orderId: ${orderId}`);
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ No transaction for Paycrest orderId: \`${orderId}\``);
      return res.status(200).send('OK');
    }

    const txDoc = txSnapshot.docs[0];
    const txData = txDoc.data();
    const userId = txData.userId;

    if (txData.status === 'Refunded') {
      logger.info(`Transaction ${orderId} already refunded.`);
      return res.status(200).send('OK');
    }

    await db.collection('transactions').doc(txDoc.id).update({ status: 'Refunded' });

    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🔄 *Payment Refunded*\n\n*User:* ${userId}\n*Ref ID:* ${reference}\n*Amount Returned:* ${amountReturned} ${txData.asset}`, { parse_mode: 'Markdown' });

    res.status(200).send('OK');
  } catch (error) {
    logger.error(`Error handling payment_order.refunded for orderId ${orderId}: ${error.message}`);
    res.status(500).send('Error');
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error in refunded order ${orderId}: ${error.message}`);
  }
}

// =================== Blockradar Webhook Handler ===================
app.post(WEBHOOK_BLOCKRADAR_PATH, async (req, res) => {
  const clientIp = req.clientIp;
  try {
    const event = req.body;
    logger.info(`Received Blockradar webhook from IP: ${clientIp} - ${JSON.stringify(event)}`);
    fs.appendFileSync(path.join(__dirname, 'webhook_logs.txt'), `${new Date().toISOString()} - ${JSON.stringify(event, null, 2)}\n`);

    const eventType = event.event || 'Unknown Event';
    const walletAddress = event.data?.recipientAddress || 'N/A';
    const amount = parseFloat(event.data?.amount) || 0;
    const asset = event.data?.asset?.symbol || 'N/A';
    const transactionHash = event.data?.hash || 'N/A';
    const chainRaw = event.data?.blockchain?.name || 'N/A';

    const chainKey = chainMapping[chainRaw.toLowerCase()];
    if (!chainKey) {
      logger.error(`Unknown chain received in webhook from IP: ${clientIp} - ${chainRaw}`);
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ Received deposit on unknown chain: \`${chainRaw}\` from IP: ${clientIp}`, { parse_mode: 'Markdown' });
      return res.status(400).send('Unknown chain.');
    }

    const chain = chainKey;

    if (eventType === 'deposit.success') {
      const existingTxSnapshot = await db.collection('transactions').where('transactionHash', '==', transactionHash).get();
      if (!existingTxSnapshot.empty) {
        logger.info(`Transaction with hash ${transactionHash} already exists from IP: ${clientIp}. Skipping.`);
        return res.status(200).send('OK');
      }

      const usersSnapshot = await db.collection('users').where('walletAddresses', 'array-contains', walletAddress).get();
      if (usersSnapshot.empty) {
        logger.warn(`No user found for wallet ${walletAddress} from IP: ${clientIp}`);
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ No user found for wallet address: \`${walletAddress}\` from IP: ${clientIp}`, { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      }

      const userDoc = usersSnapshot.docs[0];
      const userId = userDoc.id;
      const userState = userDoc.data();
      const wallet = userState.wallets.find((w) => w.address === walletAddress);

      if (!wallet || !wallet.bank) {
        const linkBankMsg = userState.usePidgin
          ? `💰 Deposit don land: ${amount} ${asset} for ${chainRaw}. Link bank to cash out abeg.`
          : `💰 Deposit received: ${amount} ${asset} on ${chainRaw}. Please link a bank account to cash out.`;
        await bot.telegram.sendMessage(userId, linkBankMsg, { parse_mode: 'Markdown' });
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ User ${userId} deposited but no bank linked: ${amount} ${asset}`, { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      }

      if (!SUPPORTED_ASSETS.includes(asset)) {
        const errorMsg = userState.usePidgin
          ? `⚠️ You send ${asset}, but we only take USDC/USDT. Contact [@maxcswap](https://t.me/maxcswap).`
          : `⚠️ Unsupported asset deposited: ${asset}. Only USDC/USDT supported. Contact [@maxcswap](https://t.me/maxcswap).`;
        await bot.telegram.sendPhoto(userId, { source: ERROR_IMAGE }, {
          caption: errorMsg,
          parse_mode: 'Markdown',
        });
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ User ${userId} deposited unsupported asset: ${asset} from IP: ${clientIp}`, { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      }

      const rate = exchangeRates[asset];
      if (!rate) throw new Error(`Exchange rate for ${asset} not available.`);

      const ngnAmount = calculatePayout(asset, amount);
      const referenceId = generateReferenceId();

      const transactionRef = await db.collection('transactions').add({
        userId,
        walletAddress,
        chain: chainRaw,
        amount,
        asset,
        transactionHash,
        referenceId,
        bankDetails: wallet.bank,
        payout: ngnAmount,
        timestamp: new Date().toISOString(),
        status: 'Received',
        paycrestOrderId: '',
        messageId: null,
        firstName: userState.firstName || 'Valued User'
      });

      const pendingMessage = userState.usePidgin
        ? `💰 Deposit don land:\n\n*Ref ID:* \`${referenceId}\`\n*Amount:* ${amount} ${asset}\n*Rate:* ₦${rate}\n*Network:* ${chainRaw}\n\nWe dey process am—cash go reach you soon.`
        : `💰 Deposit Received:\n\n*Reference ID:* \`${referenceId}\`\n*Amount:* ${amount} ${asset}\n*Rate:* ₦${rate}\n*Network:* ${chainRaw}\n\nWe’re processing it—cash will reach you soon.`;
      const msg = await bot.telegram.sendMessage(userId, pendingMessage, { parse_mode: 'Markdown' });
      await transactionRef.update({ messageId: msg.message_id });

      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚡️ *New Deposit*\n\n*User ID:* ${userId}\n*Amount:* ${amount} ${asset}\n*Rate:* ₦${rate}\n*NGN Amount:* ₦${ngnAmount}\n*Time:* ${new Date().toLocaleString()}\n*Bank:* ${wallet.bank.bankName}\n*Account:* ****${wallet.bank.accountNumber.slice(-4)}\n*Chain:* ${chainRaw}\n*Tx Hash:* \`${transactionHash}\`\n*Ref ID:* ${referenceId}`, { parse_mode: 'Markdown' });

      res.status(200).send('OK');
    } else if (eventType === 'deposit.swept.success') {
      const txSnapshot = await db.collection('transactions').where('transactionHash', '==', transactionHash).get();
      if (txSnapshot.empty) {
        logger.error(`No transaction found for hash ${transactionHash}`);
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ No transaction for hash: \`${transactionHash}\``);
        return res.status(200).send('OK');
      }

      const txDoc = txSnapshot.docs[0];
      const txData = txDoc.data();
      if (txData.status !== 'Received') {
        logger.info(`Transaction ${transactionHash} already processed: ${txData.status}`);
        return res.status(200).send('OK');
      }

      const userId = txData.userId;
      const userState = await getUserState(userId);
      const wallet = userState.wallets.find((w) => w.address === txData.walletAddress);

      const paycrestOrder = await createPaycrestOrder(userId, txData.amount, txData.asset, txData.chain, wallet.bank);
      await txDoc.ref.update({ paycrestOrderId: paycrestOrder.id });

      const receiveAddress = paycrestOrder.receiveAddress;
      let blockradarAssetId;
      switch (txData.asset) {
        case 'USDC': blockradarAssetId = chains[chain].assets['USDC']; break;
        case 'USDT': blockradarAssetId = chains[chain].assets['USDT']; break;
        default: throw new Error(`Unsupported asset: ${txData.asset}`);
      }

      await withdrawFromBlockradar(chainRaw, blockradarAssetId, receiveAddress, amount, paycrestOrder.id, { userId, originalTxHash: transactionHash });
      await txDoc.ref.update({ status: 'Pending' });

      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🔄 *Deposit Swept*\n\n*User:* ${userId}\n*Ref ID:* ${txData.referenceId}\n*Amount:* ${amount} ${asset}\n*Status:* Pending`, { parse_mode: 'Markdown' });

      res.status(200).send('OK');
    }
  } catch (error) {
    logger.error(`Error handling Blockradar webhook from IP: ${clientIp}: ${error.message}`);
    res.status(500).send('Error');
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error processing Blockradar webhook from IP: ${clientIp}: ${error.message}`, { parse_mode: 'Markdown' });
  }
});

// =================== Start Express Server ===================
app.listen(PORT, () => {
  logger.info(`Express server listening on port ${PORT}`);
});

// =================== Shutdown Handlers ===================
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
