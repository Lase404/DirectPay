// =================== Import Required Libraries ===================
const { Telegraf, Scenes, session, Markup } = require('telegraf');
const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const axios = require('axios');
const crypto = require('crypto');
const winston = require('winston');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp'); // For image processing
const requestIp = require('request-ip'); // For IP logging to detect Nigeria

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

const WALLET_GENERATED_IMAGE = './images/wallet_generated_base.png';
const DEPOSIT_SUCCESS_IMAGE = './images/deposit_success.png';
const PAYOUT_SUCCESS_IMAGE = './images/payout_success.png';
const ERROR_IMAGE = './images/error.png';

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
        ? '⚠️ No wallet dey here o! Click "💼 Generate Wallet" for menu to start.'
        : '⚠️ No wallet selected for linking. Please generate a wallet first.';
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

    const bankNameInput = input.toLowerCase();
    const bank = bankList.find((b) => b.aliases.includes(bankNameInput));

    const userState = await getUserState(userId);
    if (!bank) {
      const errorMsg = userState.usePidgin
        ? '❌ Bank name no correct o! Abeg enter valid bank name from this list:\n\n' + bankList.map(b => `• ${b.name}`).join('\n')
        : '❌ Invalid bank name. Please enter a valid bank name from our supported list:\n\n' + bankList.map(b => `• ${b.name}`).join('\n');
      await ctx.replyWithMarkdown(errorMsg);
      return; // Stay on the same step
    }

    ctx.session.bankData.bankName = bank.name;
    ctx.session.bankData.bankCode = bank.code;
    ctx.session.bankData.step = 2;

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

    const userState = await getUserState(userId);
    if (!/^\d{10}$/.test(input)) {
      const errorMsg = userState.usePidgin
        ? '❌ Account number no correct o! Abeg enter valid 10-digit number:'
        : '❌ Invalid account number. Please enter a valid 10-digit account number:';
      await ctx.replyWithMarkdown(errorMsg);
      return; // Stay on the same step
    }

    ctx.session.bankData.accountNumber = input;
    ctx.session.bankData.step = 3;

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
      if (!accountName) throw new Error('Unable to retrieve account name.');

      ctx.session.bankData.accountName = accountName;
      ctx.session.bankData.step = 4;

      const confirmMsg = userState.usePidgin
        ? `🏦 *Bank Account Verification*\n\n` +
          `Please confirm your bank details:\n` +
          `- *Bank Name:* ${ctx.session.bankData.bankName}\n` +
          `- *Account Number:* \`${ctx.session.bankData.accountNumber}\`\n` +
          `- *Account Holder:* ${accountName}\n\n` +
          `Na you be this abi na another person?`
        : `🏦 *Bank Account Verification*\n\n` +
          `Please confirm your bank details:\n` +
          `- *Bank Name:* ${ctx.session.bankData.bankName}\n` +
          `- *Account Number:* \`${ctx.session.bankData.accountNumber}\`\n` +
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
      const errorMsg = userState.usePidgin
        ? '❌ E no work o! Check your details well or try again later.'
        : '❌ Failed to verify your bank account. Please check your details or try again later.';
      await ctx.replyWithMarkdown(errorMsg);
      return ctx.scene.leave();
    }
  },
  async (ctx) => {
    return; // Placeholder for action handlers
  }
);

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
        ? '❌ Invalid User ID o! Abeg enter valid number (5-15 digits).'
        : '❌ Invalid User ID. Please enter a valid numeric User ID (5-15 digits):';
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }

    const userDoc = await db.collection('users').doc(userIdToMessage).get();
    if (!userDoc.exists) {
      const errorMsg = userState.usePidgin
        ? '❌ User ID no dey o! Check am well or try another.'
        : '❌ User ID not found. Please ensure the User ID is correct or try another one:';
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }

    ctx.session.userIdToMessage = userIdToMessage;
    const prompt = userState.usePidgin
      ? '📝 Abeg enter message for user, or send receipt pic:'
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
          ? '✅ Pic message don send well-well!'
          : '✅ Photo message sent successfully.';
        await ctx.replyWithMarkdown(successMsg);
        logger.info(`Admin ${adminUserId} sent photo message to user ${userIdToMessage}. Caption: ${caption}`);
      } catch (error) {
        logger.error(`Error sending photo to user ${userIdToMessage}: ${error.message}`);
        const errorMsg = userState.usePidgin
          ? '⚠️ Error send pic o! Check User ID or try again.'
          : '⚠️ Error sending photo. Please ensure the User ID is correct and the user has not blocked the bot.';
        await ctx.replyWithMarkdown(errorMsg);
      }
    } else if (ctx.message.text) {
      const messageContent = ctx.message.text.trim();
      if (!messageContent) {
        const errorMsg = userState.usePidgin
          ? '❌ Message no fit empty o! Enter something abeg.'
          : '❌ Message content cannot be empty. Please enter a valid message:';
        await ctx.replyWithMarkdown(errorMsg);
        return;
      }

      try {
        await bot.telegram.sendMessage(userIdToMessage, `📩 *Message from Admin:*\n\n${messageContent}`, { parse_mode: 'Markdown' });
        const successMsg = userState.usePidgin
          ? '✅ Text message don send well-well!'
          : '✅ Text message sent successfully.';
        await ctx.replyWithMarkdown(successMsg);
        logger.info(`Admin ${adminUserId} sent text message to user ${userIdToMessage}: ${messageContent}`);
      } catch (error) {
        logger.error(`Error sending message to user ${userIdToMessage}: ${error.message}`);
        const errorMsg = userState.usePidgin
          ? '⚠️ Error send message o! Check User ID or try again.'
          : '⚠️ Error sending message. Please ensure the User ID is correct and the user has not blocked the bot.';
        await ctx.replyWithMarkdown(errorMsg);
      }
    } else {
      const errorMsg = userState.usePidgin
        ? '❌ No good input o! Send text or pic abeg.'
        : '❌ Unsupported message type. Please send text or a photo (receipt).';
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
        ? '❌ You no get wallet o! Click "💼 Generate Wallet" to start.'
        : '❌ You have no wallets. Please generate a wallet first using the "💼 Generate Wallet" option.';
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
      ? 'Abeg pick wallet for receipt:'
      : 'Please select the wallet for which you want to generate a transaction receipt:';
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
          ? '⚠️ Bad wallet pick o! Try again.'
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
          ? 'You no get transactions for this wallet o!'
          : 'You have no transactions for this wallet.';
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

      // Export option
      const exportMsg = userState.usePidgin
        ? '\n📥 Click to export this receipt as text:'
        : '\n📥 Click to export this receipt as text:';
      await ctx.replyWithMarkdown(receiptMessage + exportMsg, Markup.inlineKeyboard([
        [Markup.button.callback('📤 Export', `export_receipt_${walletIndex}`)]
      ]));
      ctx.scene.leave();
    } catch (error) {
      logger.error(`Error generating receipt for user ${userId}: ${error.message}`);
      const errorMsg = userState.usePidgin
        ? '⚠️ Error make receipt o! Try again later.'
        : '⚠️ An error occurred while generating the receipt. Please try again later.';
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
    [walletExists ? '💼 View Wallet' : '💼 Generate Wallet', hasBankLinked ? '⚙️ Settings' : '🏦 Link Bank Account'],
    ['💰 Transactions', 'ℹ️ Support', '📘 Learn About Base'],
    ['📈 View Current Rates'],
  ]).resize();

const getSettingsMenu = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Generate New Wallet', 'settings_generate_wallet')],
    [Markup.button.callback('✏️ Edit Linked Bank Details', 'settings_edit_bank')],
    [Markup.button.callback('💬 Support', 'settings_support')],
    [Markup.button.callback('🧾 Generate Transaction Receipt', 'settings_generate_receipt')],
    [Markup.button.callback('🔙 Back to Main Menu', 'settings_back_main')],
  ]);

const getAdminMenu = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('📋 View Recent Transactions', 'admin_view_transactions')],
    [Markup.button.callback('📨 Send Message to User', 'admin_send_message')],
    [Markup.button.callback('✅ Mark Transactions as Paid', 'admin_mark_paid')],
    [Markup.button.callback('👥 View All Users', 'admin_view_users')],
    [Markup.button.callback('📢 Broadcast Message', 'admin_broadcast_message')],
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
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
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
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
    return;
  }

  const walletExists = userState.wallets.length > 0;
  const hasBankLinked = userState.wallets.some(wallet => wallet.bank);
  const adminUser = isAdmin(userId);

  const greeting = walletExists
    ? userState.usePidgin
      ? `👋 Wetin dey, ${userState.firstName} wey sabi! Welcome back to **DirectPay**, your fast crypto-to-cash hookup!\n\n💡 **Quick Start:**\n1. Link bank with "🏦 Link Bank Account"\n2. Grab your wallet address\n3. Send stablecoins, cash dey your account sharp-sharp!\n\nWe get good rates and real-time updates for you. Your money safe with us!\n\nMake we start!`
      : `👋 Hello, ${userState.firstName}!\n\nWelcome back to **DirectPay**, your gateway to seamless crypto transactions.\n\n💡 **Quick Start Guide:**\n1. **Add Your Bank Account**\n2. **Access Your Dedicated Wallet Address**\n3. **Send Stablecoins and Receive Cash Instantly**\n\nWe offer competitive rates and real-time updates to keep you informed. Your funds are secure, and you'll have cash in your account promptly!\n\nLet's get started!`
    : userState.usePidgin
      ? `👋 Welcome, ${userState.firstName}!\n\nThank you for picking **DirectPay**. Make we start your crypto journey together. Use menu below to begin.`
      : `👋 Welcome, ${userState.firstName}!\n\nThank you for choosing **DirectPay**. Let's embark on your crypto journey together. Use the menu below to get started.`;

  if (adminUser) {
    try {
      const sentMessage = await ctx.replyWithMarkdown(greeting, Markup.inlineKeyboard([
        [Markup.button.callback('🔧 Admin Panel', 'open_admin_panel')],
      ]));
      ctx.session.adminMessageId = sentMessage.message_id;
    } catch (error) {
      logger.error(`Error sending admin greeting to user ${userId}: ${error.message}`);
      await ctx.replyWithMarkdown('⚠️ An error occurred while sending the greeting. Please try again later.');
    }
  } else {
    await ctx.replyWithMarkdown(greeting, getMainMenu(walletExists, hasBankLinked));
  }
}

// =================== Generate Wallet Handler ===================
bot.hears('💼 Generate Wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    
    if (userState.wallets.length >= MAX_WALLETS) {
      const errorMsg = userState.usePidgin
        ? `⚠️ You don reach max wallets o (${MAX_WALLETS})! Manage the ones you get first abeg.`
        : `⚠️ You have reached the maximum number of wallets (${MAX_WALLETS}). Please manage your existing wallets before adding new ones.`;
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }
    
    let ratesMessage = userState.usePidgin
      ? '📈 *Current Rates o!*\n\n'
      : '📈 *Current Exchange Rates*:\n\n';
    for (const [asset, rate] of Object.entries(exchangeRates)) {
      ratesMessage += userState.usePidgin
        ? `• *${asset}*: ₦${rate}\n`
        : `• *${asset}*: ₦${rate}\n`;
    }
    ratesMessage += userState.usePidgin
      ? `\nThese rates dey work for your deposits and payouts o.'
      : `\nThese rates will be applied during your deposits and payouts.`;

    await ctx.replyWithMarkdown(ratesMessage);

    const prompt = userState.usePidgin
      ? '📂 Pick network for your new wallet, my friend:'
      : '📂 *Select the network for which you want to generate a wallet:*';
    await ctx.replyWithMarkdown(prompt, Markup.inlineKeyboard([
      [Markup.button.callback('Base', 'generate_wallet_Base')],
      [Markup.button.callback('Polygon', 'generate_wallet_Polygon')],
      [Markup.button.callback('BNB Smart Chain', 'generate_wallet_BNB Smart Chain')],
    ]));
  } catch (error) {
    logger.error(`Error handling Generate Wallet for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '⚠️ Wahala dey o! Try again later abeg.'
      : '⚠️ An error occurred while generating your wallet. Please try again later.';
    await ctx.replyWithMarkdown(errorMsg);
  }
});

bot.action(/generate_wallet_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const selectedChainRaw = ctx.match[1];
  const selectedChainKey = chainMapping[selectedChainRaw.toLowerCase()];
  if (!selectedChainKey) {
    await ctx.replyWithMarkdown('⚠️ Invalid network selection. Please try again.');
    return ctx.answerCbQuery();
  }

  const chain = selectedChainKey;

  await ctx.answerCbQuery();

  const generatingMessage = await ctx.replyWithMarkdown(`🔄 Generating Wallet for *${chain}*... Please wait a moment.`);

  try {
    const walletAddress = await generateWallet(chain);

    const userState = await getUserState(userId);
    if (userState.wallets.length >= MAX_WALLETS) {
      await ctx.replyWithMarkdown(`⚠️ You cannot generate more than ${MAX_WALLETS} wallets.`);
      await ctx.deleteMessage(generatingMessage.message_id);
      return;
    }

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
      ? `✅ *Wallet Don Land!*\n\n` +
        `*Networks:* Base, BNB Smart Chain, Polygon\n` +
        `*Assets:* USDC, USDT\n\n` +
        `Abeg link your bank account to start using am! Click "🏦 Link Bank Account" to proceed. We go show you the wallet address after you link your bank.`
      : `✅ *Wallet Generated Successfully!*\n\n` +
        `*Networks:* Base, BNB Smart Chain, Polygon\n` +
        `*Assets:* USDC, USDT\n\n` +
        `Please link your bank account to start using it! Click "🏦 Link Bank Account" to proceed. We’ll show you the wallet address once your bank is linked.`;
    await ctx.replyWithMarkdown(successMsg, { reply_markup: getMainMenu(true, false) });
  } catch (error) {
    logger.error(`Error generating wallet for user ${userId} on ${chain}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '⚠️ Wahala dey o! Try again later abeg.'
      : '⚠️ There was an issue generating your wallet. Please try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error generating wallet for user ${userId}: ${error.message}`, { parse_mode: 'Markdown' });
  }
});

// =================== View Wallet Handler ===================
bot.hears('💼 View Wallet', async (ctx, next) => {
  const userId = ctx.from.id.toString();
  const ip = ctx.requestIp || 'Unknown'; // Get client IP using requestIp
  let suggestPidgin = false;

  // Simple IP-based check for Nigeria (e.g., common Nigerian IP ranges)
  if (ip.startsWith('41.') || ip.startsWith('197.') || ip.startsWith('105.')) {
    suggestPidgin = true;
  }

  try {
    const userState = await getUserState(userId);
    
    if (userState.wallets.length === 0) {
      const errorMsg = userState.usePidgin
        ? '❌ You no get wallet o! Click "💼 Generate Wallet" to start.'
        : '❌ You have no wallets. Please generate a wallet first using the "💼 Generate Wallet" option.';
      await ctx.replyWithMarkdown(errorMsg);
      if (suggestPidgin && !userState.usePidgin) {
        await ctx.replyWithMarkdown('👋 Looks like you might be in Nigeria! Try switching to Pidgin by typing "Pidgin" for a local vibe.');
      }
      return;
    }

    const pageSize = 5;
    const totalPages = Math.ceil(userState.wallets.length / pageSize);
    ctx.session.walletsPage = ctx.session.walletsPage || 1;

    const generateWalletPage = (page) => {
      const start = (page - 1) * pageSize;
      const end = start + pageSize;
      const wallets = userState.wallets.slice(start, end);

      let message = userState.usePidgin
        ? `💼 *Your Wallets o!* (Page ${page}/${totalPages})\n\n`
        : `💼 *Your Wallets* (Page ${page}/${totalPages}):\n\n`;
      wallets.forEach((wallet, index) => {
        const walletNumber = start + index + 1;
        message += userState.usePidgin
          ? `*Wallet ${walletNumber} (${wallet.name || 'Unnamed'}):*\n• *Chain:* ${wallet.chain}\n• *Bank Linked:* ${wallet.bank ? '✅ Yes' : '❌ No'}\n`
          : `*Wallet ${walletNumber} (${wallet.name || 'Unnamed'}):*\n• *Chain:* ${wallet.chain}\n• *Bank Linked:* ${wallet.bank ? '✅ Yes' : '❌ No'}\n`;
      });

      const navigationButtons = [];
      if (page > 1) navigationButtons.push(Markup.button.callback('⬅️ Previous', `wallet_page_${page - 1}`));
      if (page < totalPages) navigationButtons.push(Markup.button.callback('Next ➡️', `wallet_page_${page + 1}`));
      navigationButtons.push(Markup.button.callback('🔄 Refresh', `wallet_page_${page}`));

      return { message, inlineKeyboard: Markup.inlineKeyboard([navigationButtons]) };
    };

    const { message, inlineKeyboard } = generateWalletPage(ctx.session.walletsPage);
    await ctx.replyWithMarkdown(message, inlineKeyboard);
    if (suggestPidgin && !userState.usePidgin) {
      await ctx.replyWithMarkdown('👋 Looks like you might be in Nigeria! Try switching to Pidgin by typing "Pidgin" for a local vibe.');
    }
  } catch (error) {
    logger.error(`Error handling View Wallet for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '⚠️ E no work o! Try again later abeg.'
      : '⚠️ An error occurred while fetching your wallets. Please try again later.';
    await ctx.replyWithMarkdown(errorMsg);
  }
});

bot.action(/wallet_page_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const requestedPage = parseInt(ctx.match[1], 10);

  try {
    const userState = await getUserState(userId);
    const pageSize = 5;
    const totalPages = Math.ceil(userState.wallets.length / pageSize);

    if (requestedPage < 1 || requestedPage > totalPages) {
      await ctx.answerCbQuery('⚠️ Invalid page number.', { show_alert: true }');
      return;
    }

    ctx.session.walletsPage = requestedPage;

    const start = (requestedPage - 1) * pageSize;
    const end = start + pageSize;
    const wallets = userState.wallets.slice(start, end);

    let message = userState.usePidgin
      ? `💼 *Your Wallets o!* (Page ${requestedPage}/${totalPages})\n\n`
      : `💼 *Your Wallets* (Page ${requestedPage}/${totalPages}):\n\n`;
    wallets.forEach((wallet, index) => {
      const walletNumber = start + index + 1;
      message += userState.usePidgin
        ? `*Wallet ${walletNumber} (${wallet.name || 'Unnamed'}):*\n• *Chain:* ${wallet.chain}\n• *Bank Linked:* ${wallet.bank ? '✅ Yes' : '❌ No'}\n`
        : `*Wallet ${walletNumber} (${wallet.name || 'Unnamed'}):*\n• *Chain:* ${wallet.chain}\n• *Bank Linked:* ${wallet.bank ? '✅ Yes' : '❌ No'}\n`;
    });

    const navigationButtons = [];
    if (requestedPage > 1) navigationButtons.push(Markup.button.callback('⬅️ Previous', `wallet_page_${requestedPage - 1}`));
    if (requestedPage < totalPages) navigationButtons.push(Markup.button.callback('Next ➡️', `wallet_page_${requestedPage + 1}`));
    navigationButtons.push(Markup.button.callback('🔄 Refresh', `wallet_page_${requestedPage}`));

    const inlineKeyboard = Markup.inlineKeyboard([navigationButtons]);

    await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: inlineKeyboard.reply_markup });
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error navigating wallet pages for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '⚠️ Error turn page o! Try again later.'
      : '⚠️ An error occurred while navigating wallets. Please try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    ctx.answerCbQuery();
  }
});

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
    const transactionsSnapshot = await db.collection('transactions')
      .where('walletAddress', '==', wallet.address)
      .orderBy('timestamp', 'desc')
      .limit(10)
      .get();

    let transactionDetails = '';
    let totalDeposits = 0;
    let totalPayouts = 0;
    transactionsSnapshot.forEach((doc) => {
      const tx = doc.data();
      totalDeposits += tx.amount || 0;
      totalPayouts += parseFloat(tx.payout || 0);
      transactionDetails += userState.usePidgin
        ? `*Ref ID:* \`${tx.referenceId || 'N/A'}\` | *Amount:* ${tx.amount || 'N/A'} ${tx.asset || 'N/A'} | *Status:* ${tx.status || 'Pending'} | *Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n`
        : `*Reference ID:* \`${tx.referenceId || 'N/A'}\` | *Amount:* ${tx.amount || 'N/A'} ${tx.asset || 'N/A'} | *Status:* ${tx.status || 'Pending'} | *Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n`;
    });

    const message = userState.usePidgin
      ? `🌟 *${wallet.name || `Wallet #${walletIndex + 1}`}*\n\n` +
        `🔹 *Address:* \`${wallet.address}\`\n` +
        `🔹 *Network:* ${wallet.chain}\n` +
        `🔹 *Assets:* USDC, USDT\n` +
        `🔹 *Bank Linked:* ${wallet.bank ? '✅ Yes' : '❌ No'}\n` +
        (wallet.bank ? `🔹 *Bank Details:*\n   - 🏦 *Bank:* ${wallet.bank.bankName}\n   - 💳 *Account:* ****${wallet.bank.accountNumber.slice(-4)}\n   - 👤 *Holder:* ${wallet.bank.accountName}\n` : '') +
        `🔹 *Creation Date:* ${new Date(wallet.creationDate).toLocaleString()}\n` +
        `🔹 *Total Deposits:* ${totalDeposits.toFixed(2)} USDC/USDT\n` +
        `🔹 *Total Payouts:* ₦${totalPayouts.toFixed(2)}\n` +
        (transactionDetails ? `🔹 *Recent Transactions:*\n${transactionDetails}` : '🔹 *No transactions yet.*\n') +
        `🔧 *Actions:*`
      : `🌟 *${wallet.name || `Wallet #${walletIndex + 1}`}*\n\n` +
        `🔹 *Address:* \`${wallet.address}\`\n` +
        `🔹 *Network:* ${wallet.chain}\n` +
        `🔹 *Supported Assets:* USDC, USDT\n` +
        `🔹 *Bank Linked:* ${wallet.bank ? '✅ Yes' : '❌ No'}\n` +
        (wallet.bank ? `🔹 *Bank Details:*\n   - 🏦 *Bank:* ${wallet.bank.bankName}\n   - 💳 *Account:* ****${wallet.bank.accountNumber.slice(-4)}\n   - 👤 *Holder:* ${wallet.bank.accountName}\n` : '') +
        `🔹 *Creation Date:* ${new Date(wallet.creationDate).toLocaleString()}\n` +
        `🔹 *Total Deposits:* ${totalDeposits.toFixed(2)} USDC/USDT\n` +
        `🔹 *Total Payouts:* ₦${totalPayouts.toFixed(2)}\n` +
        (transactionDetails ? `🔹 *Recent Transactions:*\n${transactionDetails}` : '🔹 *No transactions yet.*\n') +
        `🔧 *Actions:*`;

    const inlineKeyboard = Markup.inlineKeyboard([
      [Markup.button.callback('✏️ Rename', `rename_wallet_${walletIndex}`)],
      [Markup.button.callback('🏦 Edit Bank', `edit_bank_${walletIndex}`)],
      [Markup.button.callback('🗑️ Delete', `delete_wallet_${walletIndex}`)]
    ]);

    await ctx.replyWithMarkdown(message, inlineKeyboard);
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in view_wallet for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '⚠️ E no work o! Try again later abeg.'
      : '⚠️ An error occurred. Please try again.';
    await ctx.replyWithMarkdown(errorMsg);
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
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '⚠️ E no work o! Try again abeg.'
      : '⚠️ An error occurred. Please try again.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
  }
});

bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  let userState;

  try {
    userState = await getUserState(userId);
  } catch (error) {
    logger.error(`Failed to get user state in text handler for ${userId}: ${error.message}`);
    const errorMsg = userState.usePidgin
      ? '⚠️ E no work o! Try again later abeg.'
      : '⚠️ An error occurred. Please try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    return;
  }

  if (ctx.message.text.toLowerCase() === 'pidgin') {
    await updateUserState(userId, { usePidgin: true });
    const confirmMsg = userState.usePidgin
      ? `Ehen! We don switch to Pidgin for you o, ${userState.firstName || 'my friend'}!`
      : `Great! We've switched to Pidgin for you, ${userState.firstName || 'valued user'}!`;
    await ctx.replyWithMarkdown(confirmMsg);
    return;
  }

  if (ctx.session.awaitingRename !== undefined) {
    try {
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
      const errorMsg = userState.usePidgin
        ? '⚠️ E no work o! Try again abeg.'
        : '⚠️ An error occurred while renaming. Please try again.';
      await ctx.replyWithMarkdown(errorMsg);
      delete ctx.session.awaitingRename;
    }
  }

  if (ctx.session.awaitingBroadcastMessage) {
    try {
      if (!isAdmin(userId)) {
        const errorMsg = userState.usePidgin
          ? '⚠️ You no fit do this o! Admin only!'
          : '⚠️ You can’t do this! Admin only!';
        await ctx.replyWithMarkdown(errorMsg);
        await updateUserState(userId, { awaitingBroadcastMessage: false });
        return;
      }

      const messageContent = ctx.message.text.trim();
      const photo = ctx.message.photo;

      const usersSnapshot = await db.collection('users').get();
      if (usersSnapshot.empty) {
        const errorMsg = userState.usePidgin
          ? '⚠️ No users dey o! No one to send message.'
          : '⚠️ No users found to send the broadcast message.';
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
          sendPromises.push(bot.telegram.sendMessage(userTelegramId, `📢 *Broadcast Message from Admin:*\n\n${messageContent}`, { parse_mode: 'Markdown' }));
        }
      });

      await Promise.all(sendPromises);
      const successMsg = userState.usePidgin
        ? `✅ Broadcast don send to all users o!`
        : '✅ Broadcast message sent to all users.';
      await ctx.replyWithMarkdown(successMsg);
      logger.info(`Admin ${userId} sent a broadcast message to all users.`);
      await updateUserState(userId, { awaitingBroadcastMessage: false });
    } catch (error) {
      logger.error(`Error sending broadcast message: ${error.message}`);
      const errorMsg = userState.usePidgin
        ? '⚠️ E no work o! Try again abeg.'
        : '⚠️ An error occurred while sending the broadcast message. Please try again later.';
      await ctx.replyWithMarkdown(errorMsg);
      await updateUserState(userId, { awaitingBroadcastMessage: false });
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
    logger.info(`Entering bank_linking_scene for editing bank, user ${userId}, walletIndex: ${walletIndex}`);
    await ctx.scene.enter('bank_linking_scene');
    logger.info(`Successfully entered bank_linking_scene for editing, user ${userId}`);
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in edit_bank for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '⚠️ E no work o! Try again abeg.'
      : '⚠️ An error occurred. Please try again.';
    await ctx.replyWithMarkdown(errorMsg);
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
    userState.walletAddresses = userState.wallets.map(w => w.address);
    await updateUserState(userId, { wallets: userState.wallets, walletAddresses: userState.walletAddresses });

    const successMsg = userState.usePidgin
      ? `🗑️ Wallet "${wallet.name || `Wallet #${walletIndex + 1}`}" don delete o!`
      : `🗑️ Wallet "${wallet.name || `Wallet #${walletIndex + 1}`}" has been deleted successfully!`;
    await ctx.replyWithMarkdown(successMsg);
    await ctx.answerCbQuery();

    if (userState.wallets.length === 0) {
      const mainMenu = getMainMenu(false, false);
      const menuText = userState.usePidgin
        ? 'No wallets remain o! Here’s your main menu:'
        : 'No wallets remaining! Here’s your main menu:';
      await ctx.replyWithMarkdown(menuText, { reply_markup: mainMenu.reply_markup });
    } else {
      await bot.hears('💼 View Wallet')(ctx);
    }
  } catch (error) {
    logger.error(`Error in delete_wallet for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '⚠️ E no work o! Try again abeg.'
      : '⚠️ An error occurred while deleting the wallet. Please try again.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
  }
});

bot.hears('🏦 Link Bank Account', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    if (userState.wallets.length === 0) {
      const errorMsg = userState.usePidgin
        ? '❌ You no get wallet o! Click "💼 Generate Wallet" to start.'
        : '❌ You have no wallets. Please click "💼 Generate Wallet" to start.';
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }

    const lastWalletIndex = userState.wallets.length - 1;
    if (userState.wallets[lastWalletIndex].bank) {
      const errorMsg = userState.usePidgin
        ? '⚠️ This wallet don get bank o! Pick another or generate new one.'
        : '⚠️ This wallet is already linked to a bank! Please select another or generate a new one.';
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }

    ctx.session.walletIndex = lastWalletIndex;
    logger.info(`Entering bank_linking_scene for user ${userId}, walletIndex: ${ctx.session.walletIndex}`);
    await ctx.scene.enter('bank_linking_scene');
  } catch (error) {
    logger.error(`Error initiating bank linking for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '⚠️ Wahala dey o! Try again later abeg.'
      : '⚠️ An error occurred. Please try again later.';
    await ctx.replyWithMarkdown(errorMsg);
  }
});

bot.hears('⚙️ Settings', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    const menuText = userState.usePidgin
      ? '⚙️ *Settings Menu o!*'
      : '⚙️ *Settings Menu*';
    await ctx.replyWithMarkdown(menuText, getSettingsMenu());
  } catch (error) {
    logger.error(`Error in settings handler for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '⚠️ E no work o! Try again abeg.'
      : '⚠️ An error occurred in settings. Please try again.';
    await ctx.replyWithMarkdown(errorMsg);
  }
});

bot.action(/settings_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const action = ctx.match[1];

  if (!isAdmin(userId)) {
    await ctx.reply('⚠️ Unauthorized access.');
    return ctx.answerCbQuery();
  }

  switch (action) {
    case 'generate_wallet':
      const userState = await getUserState(userId);
      const prompt = userState.usePidgin
        ? '💼 *Generate New Wallet o!*\n\nPick network for your new wallet, my friend:'
        : '💼 *Generate New Wallet*\n\nSelect the network for which you want to generate a new wallet:';
      await ctx.replyWithMarkdown(prompt, Markup.inlineKeyboard([
        [Markup.button.callback('Base', 'generate_wallet_Base')],
        [Markup.button.callback('Polygon', 'generate_wallet_Polygon')],
        [Markup.button.callback('BNB Smart Chain', 'generate_wallet_BNB Smart Chain')],
      ]));
      break;

    case 'edit_bank':
      try {
        const userState = await getUserState(userId);
        if (userState.wallets.length === 0) {
          const errorMsg = userState.usePidgin
            ? '❌ You no get wallet o! Click "💼 Generate Wallet" to start.'
            : '❌ You have no wallets. Please generate a wallet first using the "💼 Generate Wallet" option.';
          await ctx.replyWithMarkdown(errorMsg);
          return;
        }

        if (userState.wallets.length === 1) {
          ctx.session.walletIndex = 0;
          await ctx.scene.enter('bank_linking_scene');
        } else {
          let keyboard = userState.wallets.map((wallet, index) => [
            Markup.button.callback(`Wallet ${index + 1} - ${wallet.chain}`, `select_wallet_edit_bank_${index}`)
          ]);
          const prompt = userState.usePidgin
            ? 'Pick wallet to edit bank o:'
            : 'Please select the wallet for which you want to edit the bank details:';
          await ctx.reply(prompt, Markup.inlineKeyboard(keyboard));
        }
      } catch (error) {
        logger.error(`Error handling Edit Linked Bank Details in Settings for user ${userId}: ${error.message}`);
        const userState = await getUserState(userId);
        const errorMsg = userState.usePidgin
          ? '⚠️ Error edit bank o! Try again later.'
          : '⚠️ An error occurred while editing your bank details. Please try again later.';
        await ctx.replyWithMarkdown(errorMsg);
      }
      break;

    case 'support':
      const supportMsg = userState.usePidgin
        ? '🛠️ *Support o!*\n\nPick option below:'
        : '🛠️ *Support Section*\n\nSelect an option below:';
      await ctx.replyWithMarkdown(supportMsg, Markup.inlineKeyboard([
        [Markup.button.callback('❓ How It Works', 'support_how_it_works')],
        [Markup.button.callback('⚠️ Transaction Not Received', 'support_not_received')],
        [Markup.button.callback('💬 Contact Support', 'support_contact')],
      ]));
      break;

    case 'generate_receipt':
      try {
        const userState = await getUserState(userId);
        if (userState.wallets.length === 0) {
          const errorMsg = userState.usePidgin
            ? '❌ You no get wallet o! Click "💼 Generate Wallet" to start.'
            : '❌ You have no wallets. Please generate a wallet first using the "💼 Generate Wallet" option.';
          await ctx.replyWithMarkdown(errorMsg);
          return;
        }

        let keyboard = userState.wallets.map((wallet, index) => [
          Markup.button.callback(`Wallet ${index + 1} - ${wallet.chain}`, `select_receipt_wallet_${index}`)
        ]);
        const prompt = userState.usePidgin
          ? 'Pick wallet for receipt o:'
          : 'Please select the wallet for which you want to generate a transaction receipt:';
        await ctx.reply(prompt, Markup.inlineKeyboard(keyboard));
      } catch (error) {
        logger.error(`Error handling Generate Transaction Receipt in Settings for user ${userId}: ${error.message}`);
        const userState = await getUserState(userId);
        const errorMsg = userState.usePidgin
          ? '⚠️ Error make receipt o! Try again later.'
          : '⚠️ An error occurred while generating the receipt. Please try again later.';
        await ctx.replyWithMarkdown(errorMsg);
      }
      break;

    case 'back_to_main':
      await greetUser(ctx);
      break;

    default:
      await ctx.answerCbQuery('⚠️ Unknown settings option selected.');
  }
    await ctx.answerCbQuery();
});

bot.action(/select_wallet_edit_bank_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);

  if (isNaN(walletIndex)) {
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '⚠️ Bad wallet pick o! Try again.'
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
      ? '⚠️ Bad wallet pick o! Try again.'
      : '⚠️ Invalid wallet selection. Please try again.';
    await ctx.replyWithMarkdown(errorMsg);
    return ctx.answerCbQuery();
  }

  ctx.session.walletIndex = walletIndex;
  await ctx.scene.enter('receipt_generation_scene');
  ctx.answerCbQuery();
});

bot.hears(/ℹ️\s*Support/i, async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    const supportMsg = userState.usePidgin
      ? '🛠️ *Support o!*\n\nPick option below:'
      : '🛠️ *Support Section*\n\nSelect an option below:';
    await ctx.replyWithMarkdown(supportMsg, Markup.inlineKeyboard([
      [Markup.button.callback('❓ How It Works', 'support_how_it_works')],
      [Markup.button.callback('⚠️ Transaction Not Received', 'support_not_received')],
      [Markup.button.callback('💬 Contact Support', 'support_contact')],
    ]));
  } catch (error) {
    logger.error(`Error in support handler for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '⚠️ E no work o! Try again abeg.'
      : '⚠️ An error occurred. Please try again.';
    await ctx.replyWithMarkdown(errorMsg);
  }
});

const detailedTutorials = {
  how_it_works: userState.usePidgin
    ? `**📘 How DirectPay Work o!**\n\n1. *Make Wallet:* Click "💼 Generate Wallet", pick network, get your address.\n2. *Link Bank:* After wallet, give us your bank details for fast cash.\n3. *Get Money:* Share wallet address, we turn crypto to NGN quick-quick.\n4. *Check Transactions:* Use "💰 Transactions" to see all.\n5. *Help:* Ask us anytime with "ℹ️ Support".\n\n🔒 *Safe o!* We use top security for your money and info.\n💬 *Need Help?* Talk to [@maxcswap](https://t.me/maxcswap).`
    : `**📘 How DirectPay Works**\n\n1. **Generate Your Wallet:**\n   - Navigate to the "💼 Generate Wallet" option.\n   - Select your preferred network (Base, Polygon, BNB Smart Chain).\n   - Receive a unique wallet address where you can receive crypto payments.\n2. **Link Your Bank Account:**\n   - After generating your wallet, provide your bank details to securely receive payouts directly into your bank account.\n3. **Receive Payments:**\n   - Share your wallet address with clients or payment sources.\n   - Once a deposit is made, DirectPay will automatically convert the crypto to NGN at current exchange rates.\n4. **Monitor Transactions:**\n   - Use the "💰 Transactions" option to view all your deposit and payout activities.\n5. **Support & Assistance:**\n   - Access detailed support tutorials anytime from the "ℹ️ Support" section.\n\n**🔒 Security:**\nYour funds are secure with us. We utilize industry-standard encryption and security protocols to ensure your assets and information remain safe.\n\n**💬 Need Help?**\nVisit the support section or contact our support team at [@maxcswap](https://t.me/maxcswap) for any assistance.`,
  transaction_guide: userState.usePidgin
    ? `**💰 Transaction No Come?**\n\nIf your money no show, do this:\n1. *Check Address:* Make sure sender use correct wallet address.\n2. *Check Bank:* Confirm your bank dey linked. If no, go "⚙️ Settings" > "🏦 Link Bank Account".\n3. *See Status:* Use "💰 Transactions" to check if e dey process.\n4. *Wait Small:* E fit take time if network dey jam.\n5. *Talk to Us:* If still no work, contact [@maxcswap](https://t.me/maxcswap) with your details.\n`
    : `**💰 Transaction Not Received?**\n\nIf you haven't received your transaction, follow these steps to troubleshoot:\n1. **Verify Wallet Address:**\n   - Ensure that the sender used the correct wallet address provided by DirectPay.\n2. **Check Bank Linking:**\n   - Make sure your bank account is correctly linked.\n   - If not linked, go to "⚙️ Settings" > "🏦 Link Bank Account" to add your bank details.\n3. **Monitor Transaction Status:**\n   - Use the "💰 Transactions" section to check the status of your deposit.\n   - Pending status indicates that the deposit is being processed.\n4. **Wait for Confirmation:**\n   - Deposits might take a few minutes to reflect depending on the network congestion.\n5. **Contact Support:**\n   - If the issue persists after following the above steps, reach out to our support team at [@maxcswap](https://t.me/maxcswap) with your transaction details for further assistance.`,
  link_bank_tutorial: userState.usePidgin
    ? `**🏦 How to Edit Bank o!**\n*Edit Your Bank Account:*\n1. *Go to Edit:* Click "⚙️ Settings" > "✏️ Edit Linked Bank Details".\n2. *Pick Wallet:* Choose wallet to change bank.\n3. *Give New Details:* Enter new bank name or account number.\n4. *Confirm:* Check new account holder name.\n5. *Finish:* Your bank don update sharp-sharp!`
    : `**🏦 How to Edit Your Bank Account**\n*Editing an Existing Bank Account:*\n1. **Navigate to Bank Editing:**\n   - Click on "⚙️ Settings" > "✏️ Edit Linked Bank Details" from the main menu.\n2. **Select the Wallet:**\n   - Choose the wallet whose bank account you wish to edit.\n3. **Provide New Bank Details:**\n   - Enter the updated bank name or account number as required.\n4. **Verify Changes:**\n   - Confirm the updated account holder name.\n5. **Completion:**\n   - Your bank account details have been updated successfully.`,
};

bot.hears(/📘\s*Learn About Base/i, async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    await sendBaseContent(ctx, 0, true);
  } catch (error) {
    logger.error(`Error in learn about base handler for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '⚠️ E no work o! Try again abeg.'
      : '⚠️ An error occurred. Please try again.';
    await ctx.replyWithMarkdown(errorMsg);
  }
});

const baseContent = [
  {
    title: 'Welcome to Base',
    text: userState.usePidgin
      ? 'Base na secure, cheap Ethereum Layer 2 wey make apps easy to use o!'
      : 'Base is a secure, low-cost, and developer-friendly Ethereum Layer 2 network. It offers a seamless way to onboard into the world of decentralized applications.',
  },
  {
    title: 'Why Choose Base?',
    text: userState.usePidgin
      ? '- *Low Fees:* Less cost for transactions.\n- *Fast:* Quick confirmations.\n- *Safe:* Built on Ethereum security.\n- *Easy for Devs:* Work with EVM tools.'
      : '- **Lower Fees**: Significantly reduced transaction costs.\n- **Faster Transactions**: Swift confirmation times.\n- **Secure**: Built on Ethereum’s robust security.\n- **Developer-Friendly**: Compatible with EVM tools and infrastructure.',
  },
  {
    title: 'Getting Started',
    text: userState.usePidgin
      ? 'To start, bridge your money from Ethereum to Base with [Bridge Assets to Base](https://base.org/bridge).'
      : 'To start using Base, you can bridge your assets from Ethereum to Base using the official bridge at [Bridge Assets to Base](https://base.org/bridge).',
  },
  {
    title: 'Learn More',
    text: userState.usePidgin
      ? 'Check [Base Docs](https://docs.base.org) for more gist!'
      : 'Visit the official documentation at [Base Documentation](https://docs.base.org) for in-depth guides and resources.',
  },
];

async function sendBaseContent(ctx, index, isNew = true) {
  const userState = await getUserState(ctx.from.id.toString());
  const content = baseContent[index];
  const totalPages = baseContent.length;

  const navigationButtons = [];
  if (index > 0) navigationButtons.push(Markup.button.callback('⬅️ Back', `base_page_${index - 1}`));
  if (index < totalPages - 1) navigationButtons.push(Markup.button.callback('Next ➡️', `base_page_${index + 1}`));
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
    await ctx.answerCbQuery('⚠️ Invalid page number.', { show_alert: true }');
    return;
  }
  await sendBaseContent(ctx, index, false);
  await ctx.answerCbQuery();
});

bot.action('exit_base', async (ctx) => {
  if (ctx.session.baseMessageId) {
    await ctx.deleteMessage(ctx.session.baseMessageId).catch(() => {});
    ctx.session.baseMessageId = null;
  }
  const userState = await getUserState(ctx.from.id.toString());
  const msg = userState.usePidgin
    ? 'Thank you for learn about Base o!'
    : 'Thank you for learning about Base!';
  await ctx.replyWithMarkdown(msg);
  await ctx.answerCbQuery();
});

bot.action('support_how_it_works', async (ctx) => {
  const userState = await getUserState(ctx.from.id.toString());
  await ctx.replyWithMarkdown(detailedTutorials.how_it_works);
  await ctx.answerCbQuery();
});

bot.action('support_not_received', async (ctx) => {
  const userState = await getUserState(ctx.from.id.toString());
  await ctx.replyWithMarkdown(detailedTutorials.transaction_guide);
  await ctx.answerCbQuery();
});

bot.action('support_contact', async (ctx) => {
  const userState = await getUserState(ctx.from.id.toString());
  const msg = userState.usePidgin
    ? 'You fit contact support at [@maxcswap](https://t.me/maxcswap) o!'
    : 'You can contact our support team at [@maxcswap](https://t.me/maxcswap).';
  await ctx.replyWithMarkdown(msg);
  await ctx.answerCbQuery();
});

bot.hears(/💰\s*Transactions/i, async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    const pageSize = 5;
    ctx.session.transactionsPage = ctx.session.transactionsPage || 1;

    const generateTransactionPage = async (page, walletFilter = null) => {
      let transactionsSnapshot;
      if (walletFilter) {
        transactionsSnapshot = await db.collection('transactions')
          .where('walletAddress', '==', walletFilter)
          .orderBy('timestamp', 'desc')
          .limit(pageSize)
          .offset((page - 1) * pageSize)
          .get();
      } else {
        transactionsSnapshot = await db.collection('transactions')
          .orderBy('timestamp', 'desc')
          .limit(pageSize)
          .offset((page - 1) * pageSize)
          .get();
      }
      const totalDocs = await db.collection('transactions').count().get();
      const totalPages = Math.ceil(totalDocs.data().count / pageSize);

      let message = userState.usePidgin
        ? `💰 *Your Transactions o!* (Page ${page}/${totalPages})${walletFilter ? ' - Filtered by Wallet' : ''}\n\n`
        : `💰 *Your Transactions* (Page ${page}/${totalPages})${walletFilter ? ' - Filtered by Wallet' : ''}:\n\n`;
      transactionsSnapshot.forEach((doc) => {
        const tx = doc.data();
        message += userState.usePidgin
          ? `*Ref ID:* \`${tx.referenceId || 'N/A'}\` | *Amount:* ${tx.amount || 'N/A'} ${tx.asset || 'N/A'} | *Status:* ${tx.status || 'Pending'} | *Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n`
          : `*Reference ID:* \`${tx.referenceId || 'N/A'}\` | *Amount:* ${tx.amount || 'N/A'} ${tx.asset || 'N/A'} | *Status:* ${tx.status || 'Pending'} | *Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n`;
      });

      const navigationButtons = [];
      if (page > 1) navigationButtons.push(Markup.button.callback('⬅️ Previous', `transaction_page_${page - 1}${walletFilter ? `_${walletFilter}` : ''}`));
      if (page < totalPages) navigationButtons.push(Markup.button.callback('Next ➡️', `transaction_page_${page + 1}${walletFilter ? `_${walletFilter}` : ''}`));
      navigationButtons.push(Markup.button.callback('🔄 Refresh', `transaction_page_${page}${walletFilter ? `_${walletFilter}` : ''}`));
      if (userState.wallets.length > 1) {
        const filterButtons = userState.wallets.map((w, idx) => Markup.button.callback(`Filter ${w.chain}`, `filter_transactions_${idx}`));
        navigationButtons.push(...filterButtons);
      }
      navigationButtons.push(Markup.button.callback('📤 Export Report', `export_transactions_${page}${walletFilter ? `_${walletFilter}` : ''}`));

      return { message, inlineKeyboard: Markup.inlineKeyboard([navigationButtons]) };
    };

    const { message, inlineKeyboard } = await generateTransactionPage(ctx.session.transactionsPage);
    await ctx.replyWithMarkdown(message, inlineKeyboard);
  } catch (error) {
    logger.error(`Error fetching transactions for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '⚠️ Unable to fetch transactions o! Try again later.'
      : '⚠️ Unable to fetch transactions. Please try again later.';
    await ctx.replyWithMarkdown(errorMsg);
  }
});

bot.action(/transaction_page_(\d+)(?:_(.+))?/ , async (ctx) => {
  const userId = ctx.from.id.toString();
  const requestedPage = parseInt(ctx.match[1], 10);
  const walletAddress = ctx.match[2];

  try {
    const userState = await getUserState(userId);
    const pageSize = 5;
    const totalDocs = await db.collection('transactions').count().get();
    const totalPages = Math.ceil(totalDocs.data().count / pageSize);

    if (requestedPage < 1 || requestedPage > totalPages) {
      await ctx.answerCbQuery('⚠️ Invalid page number.', { show_alert: true }');
      return;
    }

    ctx.session.transactionsPage = requestedPage;

    const { message, inlineKeyboard } = await generateTransactionPage(requestedPage, walletAddress);
    await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: inlineKeyboard.reply_markup });
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error navigating transaction pages for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '⚠️ Error turn page o! Try again later.'
      : '⚠️ An error occurred while navigating transactions. Please try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
  }
});

bot.action(/filter_transactions_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);
  try {
    const userState = await getUserState(userId);
    if (walletIndex < 0 || walletIndex >= userState.wallets.length) {
      const errorMsg = userState.usePidgin
        ? '⚠️ Bad wallet pick o! Try again.'
        : '⚠️ Invalid wallet selection. Please try again.';
      await ctx.replyWithMarkdown(errorMsg);
      return ctx.answerCbQuery();
    }

    ctx.session.transactionsPage = 1;
    const walletAddress = userState.wallets[walletIndex].address;
    const { message, inlineKeyboard } = await generateTransactionPage(1, walletAddress);
    await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: inlineKeyboard.reply_markup });
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error filtering transactions for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '⚠️ Error filter transactions o! Try again later.'
      : '⚠️ An error occurred while filtering transactions. Please try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
  }
});

bot.action(/export_receipt_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);
  try {
    const userState = await getUserState(userId);
    if (walletIndex < 0 || walletIndex >= userState.wallets.length) {
      const errorMsg = userState.usePidgin
        ? '⚠️ Bad wallet pick o! Try again.'
        : '⚠️ Invalid wallet selection. Please try again.';
      await ctx.replyWithMarkdown(errorMsg);
      return ctx.answerCbQuery();
    }

    const wallet = userState.wallets[walletIndex];
    const transactionsSnapshot = await db.collection('transactions')
      .where('walletAddress', '==', wallet.address)
      .orderBy('timestamp', 'desc')
      .get();

    let receiptContent = userState.usePidgin
      ? `🧾 *Receipt for ${wallet.name || `Wallet #${walletIndex + 1}`} - ${wallet.chain}*\n`
      : `🧾 *Transaction Receipt for ${wallet.name || `Wallet #${walletIndex + 1}`} - ${wallet.chain}*\n`;
    transactionsSnapshot.forEach((doc) => {
      const tx = doc.data();
      receiptContent += userState.usePidgin
        ? `*Ref ID:* \`${tx.referenceId || 'N/A'}\` | *Amount:* ${tx.amount || 'N/A'} ${tx.asset || 'N/A'} | *Status:* ${tx.status || 'Pending'} | *Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n`
        : `*Reference ID:* \`${tx.referenceId || 'N/A'}\` | *Amount:* ${tx.amount || 'N/A'} ${tx.asset || 'N/A'} | *Status:* ${tx.status || 'Pending'} | *Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n`;
    });

    await bot.telegram.sendMessage(userId, `📤 *Exported Receipt:*\n\n${receiptContent}`, { parse_mode: 'Markdown' });
    const successMsg = userState.usePidgin
      ? '✅ Receipt don export o!'
      : '✅ Receipt exported successfully!';
    await ctx.answerCbQuery(successMsg);
  } catch (error) {
    logger.error(`Error exporting receipt for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '⚠️ Error export receipt o! Try again later.'
      : '⚠️ An error occurred while exporting the receipt. Please try again later.';
    await ctx.answerCbQuery(errorMsg, { show_alert: true });
  }
});

bot.action(/export_transactions_(\d+)(?:_(.+))?/ , async (ctx) => {
  const userId = ctx.from.id.toString();
  const page = parseInt(ctx.match[1], 10);
  const walletAddress = ctx.match[2];
  try {
    const userState = await getUserState(userId);
    const transactionsSnapshot = await db.collection('transactions')
      .where('walletAddress', '==', walletAddress || '')
      .orderBy('timestamp', 'desc')
      .offset((page - 1) * 5)
      .limit(5)
      .get();

    let reportContent = userState.usePidgin
      ? `📊 *Transaction Report o!* (Page ${page})\n`
      : `📊 *Transaction Report* (Page ${page})\n`;
    transactionsSnapshot.forEach((doc) => {
      const tx = doc.data();
      reportContent += userState.usePidgin
        ? `*Ref ID:* \`${tx.referenceId || 'N/A'}\` | *Amount:* ${tx.amount || 'N/A'} ${tx.asset || 'N/A'} | *Status:* ${tx.status || 'Pending'} | *Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n`
        : `*Reference ID:* \`${tx.referenceId || 'N/A'}\` | *Amount:* ${tx.amount || 'N/A'} ${tx.asset || 'N/A'} | *Status:* ${tx.status || 'Pending'} | *Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n`;
    });

    await bot.telegram.sendMessage(userId, `📤 *Exported Transaction Report:*\n\n${reportContent}`, { parse_mode: 'Markdown' });
    const successMsg = userState.usePidgin
      ? '✅ Report don export o!'
      : '✅ Transaction report exported successfully!';
    await ctx.answerCbQuery(successMsg);
  } catch (error) {
    logger.error(`Error exporting transactions for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '⚠️ Error export report o! Try again later.'
      : '⚠️ An error occurred while exporting the transaction report. Please try again later.';
    await ctx.answerCbQuery(errorMsg, { show_alert: true });
  }
});

bot.action('open_admin_panel', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '⚠️ You no be admin o! Only big bosses fit enter here.'
      : '⚠️ Unauthorized access.';
    await ctx.replyWithMarkdown(errorMsg);
    return ctx.answerCbQuery();
  }

  ctx.session.adminMessageId = null;
  const userState = await getUserState(userId);
  const menuText = userState.usePidgin
    ? `👨‍💼 **Admin Panel o!**\n\nPick option below, ${userState.firstName || 'Oga'} the boss:`
    : `👨‍💼 **Admin Panel**\n\nSelect an option below, ${userState.firstName || 'esteemed user'}:`;
  const sentMessage = await ctx.replyWithMarkdown(menuText, getAdminMenu());
  ctx.session.adminMessageId = sentMessage.message_id;
  await ctx.answerCbQuery();
});

bot.action(/admin_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    await ctx.reply('⚠️ Unauthorized access.');
    return ctx.answerCbQuery();
  }

  const action = ctx.match[1];
  const userState = await getUserState(userId);

  switch (action) {
    case 'view_transactions':
      try {
        const transactionsSnapshot = await db.collection('transactions').orderBy('timestamp', 'desc').limit(10).get();
        if (transactionsSnapshot.empty) {
          await ctx.answerCbQuery(userState.usePidgin ? 'No transactions dey o!' : 'No transactions found.', { show_alert: true }');
          return;
        }

        let message = userState.usePidgin
          ? '📋 **Recent Transactions o!**\n\n'
          : '📋 **Recent Transactions**:\n\n';
        transactionsSnapshot.forEach((doc) => {
          const tx = doc.data();
          message += userState.usePidgin
            ? `*User ID:* ${tx.userId || 'N/A'}\n*Ref ID:* \`${tx.referenceId || 'N/A'}\`\n*Amount:* ${tx.amount || 'N/A'} ${tx.asset || 'N/A'}\n*Status:* ${tx.status || 'Pending'}\n*Chain:* ${tx.chain || 'N/A'}\n*Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n\n`
            : `*User ID:* ${tx.userId || 'N/A'}\n*Reference ID:* \`${tx.referenceId || 'N/A'}\`\n*Amount Deposited:* ${tx.amount || 'N/A'} ${tx.asset || 'N/A'}\n*Status:* ${tx.status || 'Pending'}\n*Chain:* ${tx.chain || 'N/A'}\n*Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n\n`;
        });

        const inlineKeyboard = Markup.inlineKeyboard([[Markup.button.callback('🔙 Back to Admin Menu', 'admin_back_to_main')]]);
        await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: inlineKeyboard.reply_markup });
        await ctx.answerCbQuery();
      } catch (error) {
        logger.error(`Error fetching all transactions: ${error.message}`);
        await ctx.answerCbQuery(userState.usePidgin ? '⚠️ Unable to fetch transactions o!' : '⚠️ Unable to fetch transactions.', { show_alert: true });
      }
      break;

    case 'send_message':
      try {
        const usersSnapshot = await db.collection('users').get();
        if (usersSnapshot.empty) {
          const errorMsg = userState.usePidgin
            ? '⚠️ No users dey o! No one to send message.'
            : '⚠️ No users found to send messages.';
          await ctx.replyWithMarkdown(errorMsg);
          return ctx.answerCbQuery();
        }
        await ctx.scene.enter('send_message_scene');
        await ctx.answerCbQuery();
      } catch (error) {
        logger.error(`Error initiating send message: ${error.message}`);
        const errorMsg = userState.usePidgin
          ? '⚠️ Error start message o! Try again later.'
          : '⚠️ An error occurred while initiating the message. Please try again later.';
        await ctx.replyWithMarkdown(errorMsg);
        await ctx.answerCbQuery();
      }
      break;

    case 'mark_paid':
      try {
        const pendingTransactions = await db.collection('transactions').where('status', '==', 'Pending').get();
        if (pendingTransactions.empty) {
          await ctx.answerCbQuery(userState.usePidgin ? 'No pending transactions dey o!' : 'No pending transactions found.', { show_alert: true }');
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

            const successMsg = userState.usePidgin
              ? `🎉 *Money Don Pay!*\n\n*Ref ID:* \`${txData.referenceId || 'N/A'}\`\n*Amount:* ${txData.amount} ${txData.asset}\n*Bank:* ${txData.bankDetails.bankName || 'N/A'}\n*Account Name:* ${accountName}\n*Account Number:* ****${txData.bankDetails.accountNumber.slice(-4)}\n*Payout:* ₦${payout}\n\nThank you for use *DirectPay*! Money don land your bank!'
              : `🎉 *Transaction Successful!*\n\n*Reference ID:* \`${txData.referenceId || 'N/A'}\`\n*Amount Paid:* ${txData.amount} ${txData.asset}\n*Bank:* ${txData.bankDetails.bankName || 'N/A'}\n*Account Name:* ${accountName}\n*Account Number:* ****${txData.bankDetails.accountNumber.slice(-4)}\n*Payout (NGN):* ₦${payout}\n\nThank you for using *DirectPay*! Your funds have been securely transferred to your bank account.`;
            await bot.telegram.sendMessage(txData.userId, successMsg, { parse_mode: 'Markdown' });
            logger.info(`Notified user ${txData.userId} about paid transaction ${txData.referenceId}`);
          } catch (error) {
            logger.error(`Error notifying user ${txData.userId}: ${error.message}`);
          }
        });

        const confirmMsg = userState.usePidgin
          ? '✅ All pending transactions don mark as paid o!'
          : '✅ All pending transactions have been marked as paid.';
        await ctx.editMessageText(confirmMsg, { reply_markup: getAdminMenu() });
        await ctx.answerCbQuery();
      } catch (error) {
        logger.error(`Error marking transactions as paid: ${error.message}`);
        await ctx.answerCbQuery(userState.usePidgin ? '⚠️ Error mark paid o! Try again later.' : '⚠️ Error marking transactions as paid. Please try again later.', { show_alert: true });
      }
      break;

    case 'view_users':
      try {
        const usersSnapshot = await db.collection('users').get();
        if (usersSnapshot.empty) {
          await ctx.answerCbQuery(userState.usePidgin ? 'No users dey o!' : 'No users found., { show_alert: true }');
          return;
        }

        let message = userState.usePidgin
          ? '👥 **All Users o!**\n\n'
          : '👥 **All Users**:\n\n';
        usersSnapshot.forEach((doc) => {
          const user = doc.data();
          message += userState.usePidgin
            ? `*User ID:* ${doc.id}\n*Name:* ${user.firstName || 'N/A'}\n*Wallets:* ${user.wallets.length}\n*Bank Linked:* ${user.wallets.some(wallet => wallet.bank) ? 'Yes' : 'No'}\n\n`
            : `*User ID:* ${doc.id}\n*First Name:* ${user.firstName || 'N/A'}\n*Number of Wallets:* ${user.wallets.length}\n*Bank Linked:* ${user.wallets.some(wallet => wallet.bank) ? 'Yes' : 'No'}\n\n`;
        });

        const inlineKeyboard = Markup.inlineKeyboard([[Markup.button.callback('🔙 Back to Admin Menu', 'admin_back_to_main')]]);
        await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: inlineKeyboard.reply_markup });
        await ctx.answerCbQuery();
      } catch (error) {
        logger.error(`Error fetching all users: ${error.message}`);
        await ctx.answerCbQuery(userState.usePidgin ? '⚠️ Unable to fetch users o!' : '⚠️ Unable to fetch users., { show_alert: true }');
      }
      break;

    case 'broadcast_message':
      try {
        const usersSnapshot = await db.collection('users').get();
        if (usersSnapshot.empty) {
          const errorMsg = userState.usePidgin
            ? '⚠️ No users dey o! No one to send message.'
            : '⚠️ No users available to broadcast.';
          await ctx.replyWithMarkdown(errorMsg);
          return ctx.answerCbQuery();
        }
        ctx.session.awaitingBroadcastMessage = true;
        const prompt = userState.usePidgin
          ? '📢 Abeg type message to send to all users, or send pic:'
          : '📢 Please enter the message you want to broadcast to all users. You can also attach an image with your message:';
        await ctx.replyWithMarkdown(prompt);
        await ctx.answerCbQuery();
      } catch (error) {
        logger.error(`Error initiating broadcast message: ${error.message}`);
        const errorMsg = userState.usePidgin
          ? '⚠️ Error start broadcast o! Try again later.'
          : '⚠️ An error occurred while initiating the broadcast. Please try again later.';
        await ctx.replyWithMarkdown(errorMsg);
        await ctx.answerCbQuery();
      }
      break;

    case 'back_to_main':
      await greetUser(ctx);
      break;

    default:
      await ctx.answerCbQuery(userState.usePidgin ? '⚠️ Unknown action o! Pick from menu.' : '⚠️ Unknown action. Please select an option from the menu., { show_alert: true }');
  }
});

// =================== Handle Bank Linking Actions ===================
bankLinkingScene.action('confirm_bank_yes', async (ctx) => {
  const userId = ctx.from.id.toString();
  const bankData = ctx.session.bankData;
  const walletIndex = ctx.session.walletIndex;

  try {
    let userState = await getUserState(userId);

    if (walletIndex === undefined || walletIndex === null || !userState.wallets[walletIndex]) {
      const errorMsg = userState.usePidgin
        ? '⚠️ No wallet dey here o! Click "💼 Generate Wallet" to start.'
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

    const qrCodeBuffer = await sharp(WALLET_GENERATED_IMAGE)
      .composite([{ input: Buffer.from('QR_CODE_HERE'), top: 10, left: 10 }]) // Placeholder for QR code generation
      .toBuffer();

    const confirmationMessage = userState.usePidgin
      ? `✅ *Bank Account Don Link!*\n\n` +
        `*Bank Name:* ${bankData.bankName}\n` +
        `*Account Number:* \`${bankData.accountNumber}\`\n` +
        `*Account Holder:* ${bankData.accountName}\n\n` +
        `📂 *Wallet Details:*\n` +
        `• *Chain:* ${userState.wallets[walletIndex].chain}\n` +
        `• *Address:* \`${userState.wallets[walletIndex].address}\`\n\n` +
        `You fit start receive payouts now o!`
      : `✅ *Bank Account Linked Successfully!*\n\n` +
        `*Bank Name:* ${bankData.bankName}\n` +
        `*Account Number:* \`${bankData.accountNumber}\`\n` +
        `*Account Holder:* ${bankData.accountName}\n\n` +
        `📂 *Linked Wallet Details:*\n` +
        `• *Chain:* ${userState.wallets[walletIndex].chain}\n` +
        `• *Address:* \`${userState.wallets[walletIndex].address}\`\n\n` +
        `You can now receive payouts to this bank account.`;

    await ctx.replyWithPhoto({ source: qrCodeBuffer }, {
      caption: confirmationMessage,
      parse_mode: 'Markdown',
    });

    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🔗 User ${userId} linked a bank account:\n\n*Account Name:* ${userState.wallets[walletIndex].bank.accountName}\n*Bank Name:* ${userState.wallets[walletIndex].bank.bankName}\n*Account Number:* ****${userState.wallets[walletIndex].bank.accountNumber.slice(-4)}`, { parse_mode: 'Markdown' });
    logger.info(`User ${userId} linked a bank account: ${JSON.stringify(userState.wallets[walletIndex].bank)}`);

    await ctx.answerCbQuery();
    ctx.scene.leave();
  } catch (error) {
    logger.error(`Error in confirm_bank_yes handler for user ${userId}: ${error.message}`);
    const userState = await getUserState(userId);
    const errorMsg = userState.usePidgin
      ? '❌ Error link bank o! Try again later.'
      : '❌ An error occurred while confirming your bank details. Please try again later.';
    await ctx.replyWithMarkdown(errorMsg);
    await ctx.answerCbQuery();
    ctx.scene.leave();
  }
});

bankLinkingScene.action('confirm_bank_no', async (ctx) => {
  const userState = await getUserState(ctx.from.id.toString());
  const errorMsg = userState.usePidgin
    ? '⚠️ Let’s try again o!'
    : '⚠️ Let\'s try again.';
  await ctx.replyWithMarkdown(errorMsg);
  await ctx.scene.reenter();
  await ctx.answerCbQuery();
});

bankLinkingScene.action('cancel_bank_linking', async (ctx) => {
  const userState = await getUserState(ctx.from.id.toString());
  const errorMsg = userState.usePidgin
    ? '❌ Bank linking don cancel o!'
    : '❌ Bank linking process has been canceled.';
  await ctx.replyWithMarkdown(errorMsg);
  delete ctx.session.walletIndex;
  delete ctx.session.bankData;
  delete ctx.session.processType;
  await ctx.answerCbQuery();
  ctx.scene.leave();
});

// =================== Webhook Signature Verification ===================
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

// =================== Paycrest Webhook Handler ===================
app.post(WEBHOOK_PAYCREST_PATH, bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-paycrest-signature'];
  const rawBody = req.body;
  const clientIp = req.clientIp; // Using requestIp to get client IP

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

  const eventType = event.type;
  logger.info(`Received Paycrest event: ${eventType} from IP: ${clientIp}`);

  if (eventType === 'payment_order.settled') await handlePaymentOrderSettled(data, res);
  else if (eventType === 'payment_order.pending') await handlePaymentOrderPending(data, res);
  else if (eventType === 'payment_order.refunded') await handlePaymentOrderRefunded(data, res);
  else {
    logger.warn(`Unhandled Paycrest webhook event type: ${eventType} from IP: ${clientIp}`);
    res.status(200).send('OK');
  }
});

async function handlePaymentOrderPending(data, res) {
  const orderId = data.id;
  const status = data.status;
  const amountPaid = parseFloat(data.amountPaid) || 0;
  const reference = data.reference;

  try {
    const txSnapshot = await db.collection('transactions').where('paycrestOrderId', '==', orderId).get();
    if (txSnapshot.empty) {
      logger.error(`No transaction found for Paycrest orderId: ${orderId}`);
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ No transaction found for Paycrest orderId: \`${orderId}\``, { parse_mode: 'Markdown' });
      return res.status(200).send('OK');
    }

    const txDoc = txSnapshot.docs[0];
    const txData = txDoc.data();
    const userId = txData.userId;
    const userState = await getUserState(userId);

    await db.collection('transactions').doc(txDoc.id).update({ status: 'Pending' });

    const pendingMsg = userState.usePidgin
      ? `⏳ *Order dey process o!*\n\n*Ref ID:* \`${reference}\`\n*Amount:* ₦${amountPaid}\n*Status:* Pending\n\nWe dey work on am, wait small for update!`
      : `⏳ *Your DirectPay order is pending processing.*\n\n*Reference ID:* \`${reference}\`\n*Amount:* ₦${amountPaid}\n*Status:* Pending\n\nWe are currently processing your order. Please wait for further updates.`;
    await bot.telegram.sendMessage(userId, pendingMsg, { parse_mode: 'Markdown' });

    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🔄 *Payment Order Pending*\n\n*User:* ${txData.firstName || 'N/A'} (ID: ${userId})\n*Reference ID:* ${reference}\n*Amount Paid:* ₦${amountPaid}\n`, { parse_mode: 'Markdown' });

    res.status(200).send('OK');
  } catch (error) {
    logger.error(`Error handling payment_order.pending for orderId ${orderId}: ${error.message}`);
    res.status(500).send('Error');
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error processing Paycrest webhook for pending orderId ${orderId}: ${error.message}`, { parse_mode: 'Markdown' });
  }
}

async function handlePaymentOrderSettled(data, res) {
  const orderId = data.id;
  const status = data.status;
  const amountPaid = parseFloat(data.amountPaid) || 0;
  const reference = data.reference;

  try {
    const txSnapshot = await db.collection('transactions').where('paycrestOrderId', '==', orderId).get();
    if (txSnapshot.empty) {
      logger.error(`No transaction found for Paycrest orderId: ${orderId}`);
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ No transaction found for Paycrest orderId: \`${orderId}\``, { parse_mode: 'Markdown' });
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

    await db.collection('transactions').doc(txDoc.id).update({ status: 'Paid' });

    const successMsg = userState.usePidgin
      ? `🎉 *Money Don Land!*\n\nWetin dey, ${txData.firstName || 'Valued User'}!\n\nYour DirectPay order don complete o:\n*Crypto Amount:* ${txData.amount} ${txData.asset}\n*Cash Amount:* ₦${txData.payout}\n*Rate:* ₦${exchangeRates[txData.asset] || 'N/A'} per ${txData.asset}\n*Network:* ${txData.chain}\n*Date:* ${new Date(txData.timestamp).toISOString()}\n\nThank you for use *DirectPay*! Money don land your bank!`
      : `🎉 *Funds Credited Successfully!*\n\nHello ${txData.firstName || 'Valued User'},\n\nYour DirectPay order has been completed. Here are the details of your order:\n*Crypto amount:* ${txData.amount} ${txData.asset}\n*Cash amount:* NGN ${txData.payout}\n*Exchange Rate:* ₦${exchangeRates[txData.asset] || 'N/A'} per ${txData.asset}\n*Network:* ${txData.chain}\n*Date:* ${new Date(txData.timestamp).toISOString()}\n\nThank you for using *DirectPay*! Your funds have been securely transferred to your bank account.`;
    await bot.telegram.sendPhoto(userId, { source: PAYOUT_SUCCESS_IMAGE }, {
      caption: successMsg,
      parse_mode: 'Markdown',
    });

    if (txData.messageId) {
      try {
        await bot.telegram.editMessageText(userId, txData.messageId, null, successMsg, { parse_mode: 'Markdown' });
        await db.collection('transactions').doc(txDoc.id).update({ status: 'Completed' });
      } catch (error) {
        logger.error(`Error editing message for user ${userId}: ${error.message}`);
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Failed to edit message for user ${userId}: ${error.message}`);
      }
    }

    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `✅ *Payment Completed*\n\n*User ID:* ${userId}\n*Reference ID:* ${txData.referenceId}\n*Amount:* ${txData.amount} ${txData.asset}\n*Bank:* ${txData.bankDetails.bankName}\n*Account Number:* ****${txData.bankDetails.accountNumber.slice(-4)}\n*Date:* ${new Date(txData.timestamp).toLocaleString()}\n`, { parse_mode: 'Markdown' });

    res.status(200).send('OK');
  } catch (error) {
    logger.error(`Error processing Paycrest webhook for orderId ${orderId}: ${error.message}`);
    res.status(500).send('Error');
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error processing Paycrest webhook for orderId ${orderId}: ${error.message}`, { parse_mode: 'Markdown' });
  }
}

async function handlePaymentOrderRefunded(data, res) {
  const orderId = data.id;
  const status = data.status;
  const amountPaid = parseFloat(data.amountPaid) || 0;
  const reference = data.reference;

  try {
    const txSnapshot = await db.collection('transactions').where('paycrestOrderId', '==', orderId).get();
    if (txSnapshot.empty) {
      logger.error(`No transaction found for Paycrest orderId: ${orderId}`);
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ No transaction found for Paycrest orderId: \`${orderId}\``, { parse_mode: 'Markdown' });
      return res.status(200).send('OK');
    }

    const txDoc = txSnapshot.docs[0];
    const txData = txDoc.data();
    const userId = txData.userId;
    const userState = await getUserState(userId);

    if (txData.status === 'Refunded') {
      logger.info(`Transaction ${orderId} already refunded.`);
      return res.status(200).send('OK');
    }

    await db.collection('transactions').doc(txDoc.id).update({ status: 'Refunded' });

    const refundMsg = userState.usePidgin
      ? `❌ *Order Don Refund o!*\n\nSorry ${txData.firstName || 'Valued User'}, your order with *Ref ID:* \`${reference}\` don refund.\n*Reason:* We get problem process am. Money don go back to your payment way.\nIf e be mistake, contact [@maxcswap](https://t.me/maxcswap) o!\nThank you for understand.'
      : `❌ *Your DirectPay order has been refunded.*\n\nHello ${txData.firstName || 'Valued User'},\n\nWe regret to inform you that your DirectPay order with *Reference ID:* \`${reference}\` has been refunded.\n*Reason:* We experienced issues while processing your order. Rest assured, the funds have been returned to your original payment method.\n\nIf you believe this is a mistake or need further assistance, please don't hesitate to contact our support team at [@maxcswap](https://t.me/maxcswap).\n\nThank you for your understanding.`;
    await bot.telegram.sendPhoto(userId, { source: ERROR_IMAGE }, {
      caption: refundMsg,
      parse_mode: 'Markdown',
    });

    if (txData.messageId) {
      try {
        await bot.telegram.editMessageText(userId, txData.messageId, null, refundMsg, { parse_mode: 'Markdown' });
      } catch (error) {
        logger.error(`Error editing message for user ${userId}: ${error.message}`);
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Failed to edit message for user ${userId}: ${error.message}`);
      }
    }

    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🔄 *Payment Order Refunded*\n\n*User:* ${txData.firstName || 'N/A'} (ID: ${userId})\n*Reference ID:* ${reference}\n*Amount Paid:* ₦${amountPaid}\n`, { parse_mode: 'Markdown' });

    res.status(200).send('OK');
  } catch (error) {
    logger.error(`Error handling payment_order.refunded for orderId ${orderId}: ${error.message}`);
    res.status(500).send('Error');
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error processing Paycrest webhook for refunded orderId ${orderId}: ${error.message}`, { parse_mode: 'Markdown' });
  }
}

// =================== Blockradar Webhook Handler ===================
app.post(WEBHOOK_BLOCKRADAR_PATH, async (req, res) => {
  const clientIp = req.clientIp; // Using requestIp to get client IP
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
      if (walletAddress === 'N/A') {
        logger.error(`Webhook missing wallet address from IP: ${clientIp}`);
        return res.status(400).send('Missing wallet address.');
      }

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
          ? `💰 *Deposit Don Land!*\n${amount} ${asset} don enter on ${chainRaw}. Abeg link bank to cash out o!`
          : `💰 *Deposit Received:* ${amount} ${asset} on ${chainRaw}.\nPlease link a bank account to receive your payout securely.`;
        await bot.telegram.sendMessage(userId, linkBankMsg, { parse_mode: 'Markdown' });
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ User ${userId} has received a deposit but hasn't linked a bank account from IP: ${clientIp}`, { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      }

      if (!SUPPORTED_ASSETS.includes(asset)) {
        const errorMsg = userState.usePidgin
          ? `⚠️ *Wrong Asset o!*\nYou send ${asset}, but we only take USDC and USDT. Talk to [@maxcswap](https://t.me/maxcswap) abeg!`
          : `⚠️ *Unsupported Asset Deposited:* ${asset}.\n\nCurrently, only *USDC* and *USDT* are supported. Please contact support if you believe this is an error.`;
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
        amount: amount,
        asset: asset,
        transactionHash: transactionHash,
        referenceId: referenceId,
        bankDetails: wallet.bank,
        payout: ngnAmount,
        timestamp: new Date().toISOString(),
        status: 'Processing',
        paycrestOrderId: '',
        messageId: null,
        firstName: userState.firstName || 'Valued User'
      });

      const pendingMessage = await bot.telegram.sendMessage(userId,
        userState.usePidgin
          ? `🎉 *Money Don Enter!*\n\n*Ref ID:* \`${referenceId}\`\n*Amount:* ${amount} ${asset}\n*Rate:* ₦${rate} per ${asset}\n*Network:* ${chainRaw}\n\n🔄 *Order dey process o!*\nWe dey turn your crypto to ₦${ngnAmount}. E go land your bank soon!`
          : `🎉 *Deposit Received!*\n\n*Reference ID:* \`${referenceId}\`\n*Amount Deposited:* ${amount} ${asset}\n*Exchange Rate:* ₦${rate} per ${asset}\n*Network:* ${chainRaw}\n\n🔄 *Your order has begun processing!*\n\nWe are converting your crypto to NGN at the current exchange rate of ₦${rate} per ${asset}. Your cash will be credited to your linked bank account shortly.\n\nThank you for using *DirectPay*!`,
        { parse_mode: 'Markdown' }
      );

      await transactionRef.update({ messageId: pendingMessage.message_id });

      const adminDepositMessage = userState.usePidgin
        ? `⚡️ *New Deposit o!*\n\n*User ID:* ${userId}\n*Amount:* ${amount} ${asset}\n*Rate:* ₦${rate} per ${asset}\n*NGN Amount:* ₦${ngnAmount}\n*Time:* ${new Date().toLocaleString()}\n*Bank:* ${wallet.bank.bankName}\n*Account:* ****${wallet.bank.accountNumber.slice(-4)}\n*Holder:* ${wallet.bank.accountName}\n*Chain:* ${chainRaw}\n*Tx Hash:* \`${transactionHash}\`\n*Ref ID:* ${referenceId}`
        : `⚡️ *New Deposit Received*\n\n*User ID:* ${userId}\n*Amount Deposited:* ${amount} ${asset}\n*Exchange Rate:* ₦${rate} per ${asset}\n*Amount to be Paid:* ₦${ngnAmount}\n*Time:* ${new Date().toLocaleString()}\n*Bank Details:*\n  - *Bank Name:* ${wallet.bank.bankName}\n  - *Account Number:* ****${wallet.bank.accountNumber.slice(-4)}\n  - *Holder:* ${wallet.bank.accountName}\n*Chain:* ${chainRaw}\n*Transaction Hash:* \`${transactionHash}\`\n*Reference ID:* ${referenceId}`;
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, adminDepositMessage, { parse_mode: 'Markdown' });

      const paycrestMapping = mapToPaycrest(asset, chainRaw);
      if (!paycrestMapping) {
        logger.error(`No Paycrest mapping for this asset/chain from IP: ${clientIp}`);
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ No Paycrest mapping found for asset ${asset} on chain ${chainRaw} from IP: ${clientIp}`);
        return res.status(200).send('OK');
      }

      let paycrestOrder;
      try {
        paycrestOrder = await createPaycrestOrder(userId, amount, asset, chainRaw, wallet.bank);
        await transactionRef.update({ paycrestOrderId: paycrestOrder.id });
      } catch (err) {
        logger.error(`Error creating Paycrest order for user ${userId} from IP: ${clientIp}: ${err.message}`);
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error creating Paycrest order for user ${userId} from IP: ${clientIp}: ${err.message}`, { parse_mode: 'Markdown' });
        await transactionRef.update({ status: 'Failed' });
        const failureMsg = userState.usePidgin
          ? `⚠️ *Order Fail o!*\nAbeg contact [@maxcswap](https://t.me/maxcswap) for help.`
          : `⚠️ *Your DirectPay order has failed to process.*\n\nPlease contact our support team for assistance.`;
        await bot.telegram.editMessageText(userId, pendingMessage.message_id, null, failureMsg, { parse_mode: 'Markdown' });
        return res.status(500).send('Paycrest order error');
      }

      const receiveAddress = paycrestOrder.receiveAddress;
      let blockradarAssetId;
      switch (asset) {
        case 'USDC': blockradarAssetId = chains[chain].assets['USDC']; break;
        case 'USDT': blockradarAssetId = chains[chain].assets['USDT']; break;
        default: throw new Error(`Unsupported asset: ${asset}`);
      }

      try {
        await withdrawFromBlockradar(chainRaw, blockradarAssetId, receiveAddress, amount, paycrestOrder.id, { userId, originalTxHash: transactionHash });
      } catch (err) {
        logger.error(`Error withdrawing from Blockradar for user ${userId} from IP: ${clientIp}: ${err.message}`);
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error withdrawing from Blockradar for user ${userId} from IP: ${clientIp}: ${err.message}`, { parse_mode: 'Markdown' });
        await transactionRef.update({ status: 'Failed' });
        const failureMsg = userState.usePidgin
          ? `⚠️ *Order Fail o!*\nAbeg contact [@maxcswap](https://t.me/maxcswap) for help.`
          : `⚠️ *Your DirectPay order has failed to process.*\n\nPlease contact our support team for assistance.`;
        await bot.telegram.editMessageText(userId, pendingMessage.message_id, null, failureMsg, { parse_mode: 'Markdown' });
        return res.status(500).send('Blockradar withdrawal error');
      }

      await transactionRef.update({ status: 'Pending', paycrestOrderId: paycrestOrder.id });

      const finalMsg = userState.usePidgin
        ? `🎉 *Money Don Land!*\n\nWetin dey, ${userState.firstName || 'Valued User'}!\nYour order don complete o:\n*Crypto Amount:* ${amount} ${asset}\n*Cash Amount:* ₦${ngnAmount}\n*Rate:* ₦${rate} per ${asset}\n*Network:* ${chainRaw}\n*Date:* ${new Date().toISOString()}\n\nThank you for use *DirectPay*! Money don land your bank!`
        : `🎉 *Funds Credited Successfully!*\n\nHello ${userState.firstName || 'Valued User'},\n\nYour DirectPay order has been completed. Here are the details of your order:\n*Crypto amount:* ${amount} ${asset}\n*Cash amount:* NGN ${ngnAmount}\n*Exchange Rate:* ₦${rate} per ${asset}\n*Network:* ${chainRaw}\n*Date:* ${new Date().toISOString()}\n\nThank you for using *DirectPay*! Your funds have been securely transferred to your bank account.`;
      await bot.telegram.editMessageText(userId, pendingMessage.message_id, null, finalMsg, { parse_mode: 'Markdown' });
      await transactionRef.update({ status: 'Completed' });

      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `✅ *Payment Completed*\n\n*User ID:* ${userId}\n*Reference ID:* ${referenceId}\n*Amount:* ${amount} ${asset}\n*Bank:* ${wallet.bank.bankName}\n*Account Number:* ****${wallet.bank.accountNumber.slice(-4)}\n*Date:* ${new Date().toLocaleString()} from IP: ${clientIp}\n`, { parse_mode: 'Markdown' });

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
