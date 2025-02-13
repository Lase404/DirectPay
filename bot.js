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
    new winston.transports.File({ filename: 'bot.log', maxsize: 5242880, maxFiles: 5 }) // 5MB per file, keep last 5 files
  ],
});

// =================== Firebase Setup ===================
const serviceAccountPath = path.join(__dirname, 'directpay.json'); // Ensure this file is secured on the server
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
  ADMIN_IDS = '', // Comma-separated list of admin User IDs
  WEBHOOK_PATH = '/webhook/telegram',
  WEBHOOK_PAYCREST_PATH = '/webhook/paycrest',
  WEBHOOK_BLOCKRADAR_PATH = '/webhook/blockradar',
  WEBHOOK_DOMAIN,
  PORT = 4000,
  BLOCKRADAR_BASE_API_KEY,
  BLOCKRADAR_BNB_API_KEY,
  BLOCKRADAR_POLYGON_API_KEY,
  MAX_WALLETS = 5, // Maximum number of wallets per user
} = process.env;

// =================== Validations ===================
if (!BOT_TOKEN || !PAYCREST_API_KEY || !PAYCREST_CLIENT_SECRET || !WEBHOOK_DOMAIN || !PAYSTACK_API_KEY) {
  logger.error('Missing required environment variables. Please check your .env file.');
  process.exit(1);
}

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
  // Add more banks as needed
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
  // Add more mappings if necessary
};

// =================== Helper Functions ===================

/**
 * Maps asset and chain name to Paycrest token and network.
 * @param {string} asset - Asset symbol (e.g., 'USDC', 'USDT').
 * @param {string} chainName - Name of the blockchain network.
 * @returns {object|null} - Mapped token and network or null if unsupported.
 */
function mapToPaycrest(asset, chainName) {
  // Only USDC and USDT are supported
  if (!['USDC', 'USDT'].includes(asset)) return null;

  let token = asset.toUpperCase(); // 'USDC' or 'USDT'
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

/**
 * Calculates NGN payout with service fee.
 * @param {number} amount - Amount of asset.
 * @param {number} rate - Exchange rate from Paycrest.
 * @param {number} feePercent - Service fee percentage.
 * @returns {number} - Calculated NGN amount after fee.
 */
function calculatePayoutWithFee(amount, rate, feePercent = 0.5) {
  const fee = (amount * rate) * (feePercent / 100);
  return parseFloat(((amount * rate) - fee).toFixed(2)); // Return as number with 2 decimal places for NGN
}

/**
 * Generates a unique reference ID.
 * @returns {string} - Reference ID.
 */
function generateReferenceId() {
  return 'REF-' + Math.random().toString(36).substr(2, 9).toUpperCase();
}

/**
 * Verifies bank account details using Paystack API.
 * @param {string} accountNumber - Bank account number.
 * @param {string} bankCode - Bank code.
 * @returns {object} - Verification result.
 */
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

/**
 * Creates a Paycrest order for off-ramping.
 * @param {string} userId - Telegram user ID.
 * @param {number} amount - Amount of asset.
 * @param {string} token - Asset token (e.g., 'USDC', 'USDT').
 * @param {string} network - Blockchain network.
 * @param {object} recipientDetails - Bank details of the recipient.
 * @param {string} userSendAddress - User's sending address.
 * @returns {object} - Paycrest order data.
 */
async function createPaycrestOrder(userId, amount, token, network, recipientDetails, userSendAddress) {
  try {
    // Map to Paycrest network and token
    const paycrestMapping = mapToPaycrest(token, network);
    if (!paycrestMapping) {
      throw new Error('No Paycrest mapping for the selected asset/chain.');
    }

    // Fetch the Paycrest Institution Code
    const bank = bankList.find(b => b.name.toLowerCase() === recipientDetails.bankName.toLowerCase());
    if (!bank || !bank.paycrestInstitutionCode) {
      const errorMsg = `No Paycrest institution code found for bank: ${recipientDetails.bankName}`;
      logger.error(errorMsg);
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ ${errorMsg} for user ${userId}.`);
      throw new Error(errorMsg);
    }

    const recipient = {
      institution: bank.paycrestInstitutionCode, // Use the mapped Paycrest institution code
      accountIdentifier: recipientDetails.accountNumber,
      accountName: recipientDetails.accountName,
      memo: `Payment from DirectPay`,
      providerId: "" // Assuming empty; update if necessary
    };

    // Fetch the current rate from exchangeRates
    const rate = exchangeRates[token];
    if (!rate) {
      throw new Error(`Exchange rate for ${token} not available.`);
    }

    // Payload
    const orderPayload = {
      amount: String(amount), // Token amount as string
      rate: String(rate), // Exchange rate as string from Paycrest Rate API
      network: paycrestMapping.network, // e.g., 'polygon', 'base', etc.
      token: paycrestMapping.token, // 'USDT' or 'USDC'
      recipient: recipient,
      returnAddress: userSendAddress || PAYCREST_RETURN_ADDRESS, // Use user's send address or default
      feePercent: 2, // Example fee percentage
    };

    // API request
    const orderResp = await axios.post('https://api.paycrest.io/v1/sender/orders', orderPayload, {
      headers: {
        'API-Key': PAYCREST_API_KEY,
        'Content-Type': 'application/json'
      }
    });

    // Check response
    if (orderResp.data.status !== 'success') {
      throw new Error(`Paycrest order creation failed: ${orderResp.data.message}`);
    }

    // Return the order data
    return orderResp.data.data; // Contains id, amount, token, network, receiveAddress, etc.
  } catch (err) {
    logger.error(`Error creating Paycrest order: ${err.response ? err.response.data.message : err.message}`);
    throw new Error('Failed to create Paycrest order.');
  }
}

/**
 * Withdraws assets from Blockradar to a specified address.
 * @param {string} chain - Blockchain network.
 * @param {string} assetId - Asset ID.
 * @param {string} address - Recipient address.
 * @param {number} amount - Amount to withdraw.
 * @param {string} reference - Reference ID.
 * @param {object} metadata - Additional metadata.
 * @returns {object} - Withdrawal response.
 */
async function withdrawFromBlockradar(chain, assetId, address, amount, reference, metadata) {
  try {
    // Ensure the chain exists in the mapping
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
        'x-api-key': chainData.key, // Use the mapped API key
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

/**
 * Retrieves the user's state from Firestore.
 * @param {string} userId - Telegram user ID.
 * @returns {object} - User state.
 */
async function getUserState(userId) {
  try {
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      // Initialize user state if not exists with all necessary properties
      await db.collection('users').doc(userId).set({
        firstName: '', // Will be updated upon first interaction
        wallets: [],
        walletAddresses: [],
        hasReceivedDeposit: false,
        awaitingBroadcastMessage: false, // For admin broadcast
      });
      return {
        firstName: '',
        wallets: [],
        walletAddresses: [],
        hasReceivedDeposit: false,
        awaitingBroadcastMessage: false,
      };
    } else {
      const data = userDoc.data();
      // Ensure all properties are defined, else set default values
      return {
        firstName: data.firstName || '',
        wallets: data.wallets || [],
        walletAddresses: data.walletAddresses || [],
        hasReceivedDeposit: data.hasReceivedDeposit || false,
        awaitingBroadcastMessage: data.awaitingBroadcastMessage || false,
      };
    }
  } catch (error) {
    logger.error(`Error getting user state for ${userId}: ${error.message}`);
    throw error;
  }
}

/**
 * Updates the user's state in Firestore.
 * @param {string} userId - Telegram user ID.
 * @param {object} newState - New state to update.
 */
async function updateUserState(userId, newState) {
  try {
    await db.collection('users').doc(userId).update(newState);
  } catch (error) {
    logger.error(`Error updating user state for ${userId}: ${error.message}`);
    throw error;
  }
}

/**
 * Generates a new wallet address for the specified chain.
 * @param {string} chain - Blockchain network.
 * @returns {string} - Wallet address.
 */
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
 * =================== Bank Linking Scene ===================
 */
const bankLinkingScene = new Scenes.WizardScene(
  'bank_linking_scene',
  // Step 1: Enter Bank Name
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const walletIndex = ctx.session.walletIndex;

    if (walletIndex === undefined || walletIndex === null) {
      await ctx.replyWithMarkdown('⚠️ No wallet selected for linking. Please generate a wallet first.');
      return ctx.scene.leave();
    }

    ctx.session.bankData = {};
    ctx.session.bankData.step = 1;
    await ctx.replyWithMarkdown('🏦 Please enter your bank name (e.g., Access Bank):');
    return ctx.wizard.next();
  },
  // Step 2: Enter Account Number
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const input = ctx.message.text.trim();
    logger.info(`User ${userId} entered bank name: ${input}`);

    const bankNameInput = input.toLowerCase();
    const bank = bankList.find((b) => b.aliases.includes(bankNameInput));

    if (!bank) {
      await ctx.replyWithMarkdown('❌ Invalid bank name. Please enter a valid bank name from our supported list:\n\n' + bankList.map(b => `• ${b.name}`).join('\n'));
      return; // Stay on the same step
    }

    ctx.session.bankData.bankName = bank.name;
    ctx.session.bankData.bankCode = bank.code;
    ctx.session.bankData.step = 2;

    await ctx.replyWithMarkdown('🔢 Please enter your 10-digit bank account number:');
    return ctx.wizard.next();
  },
  // Step 3: Verify Account Number
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const input = ctx.message.text.trim();
    logger.info(`User ${userId} entered account number: ${input}`);

    if (!/^\d{10}$/.test(input)) {
      await ctx.replyWithMarkdown('❌ Invalid account number. Please enter a valid 10-digit account number:');
      return; // Stay on the same step
    }

    ctx.session.bankData.accountNumber = input;
    ctx.session.bankData.step = 3;

    // Verify Bank Account
    await ctx.replyWithMarkdown('🔄 Verifying your bank details...');

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

      // Ask for Confirmation
      await ctx.replyWithMarkdown(
        `🏦 *Bank Account Verification*\n\n` +
        `Please confirm your bank details:\n` +
        `- *Bank Name:* ${ctx.session.bankData.bankName}\n` +
        `- *Account Number:* ${ctx.session.bankData.accountNumber}\n` +
        `- *Account Holder:* ${accountName}\n\n` +
        `Is this information correct?`,
        Markup.inlineKeyboard([
          [Markup.button.callback('✅ Yes, Confirm', 'confirm_bank_yes')],
          [Markup.button.callback('❌ No, Edit Details', 'confirm_bank_no')],
          [Markup.button.callback('❌ Cancel Linking', 'cancel_bank_linking')],
        ])
      );
      return ctx.wizard.next();
    } catch (error) {
      logger.error(`Error verifying bank account for user ${userId}: ${error.message}`);
      await ctx.replyWithMarkdown('❌ Failed to verify your bank account. Please ensure your details are correct or try again later.');
      return ctx.scene.leave();
    }
  },
  // Step 4: Confirmation (Handled by action handlers)
  async (ctx) => {
    // This step is intentionally left blank as confirmation is handled by action handlers
    return;
  }
);

// Handle Confirmation Actions Within the Bank Linking Scene
bankLinkingScene.action('confirm_bank_yes', async (ctx) => {
  const userId = ctx.from.id.toString();
  const bankData = ctx.session.bankData;
  const walletIndex = ctx.session.walletIndex;

  try {
    let userState = await getUserState(userId);
    const wallet = userState.wallets[walletIndex];

    if (!wallet) {
      await ctx.replyWithMarkdown('⚠️ No wallet selected for linking. Please generate a wallet first.');
      await ctx.answerCbQuery();
      return ctx.scene.leave();
    }

    // Update Bank Details for the Selected Wallet
    wallet.bank = {
      bankName: bankData.bankName,
      bankCode: bankData.bankCode,
      accountNumber: bankData.accountNumber,
      accountName: bankData.accountName,
    };

    await updateUserState(userId, { wallets: userState.wallets });

    // Detailed confirmation message
    let confirmationMessage = `👏 *Bank Account Linked Successfully!*\n\n` +
      `Welcome to DirectPay! Here are the details of your new wallet setup:\n\n` +
      `*Wallet Address:* \`${wallet.address}\`\n` +
      `*Supported Networks:* Base, BNB Smart Chain, Polygon (Matic)\n` +
      `*Supported Assets:* USDC, USDT\n\n` +
      `*Bank Name:* ${bankData.bankName}\n` +
      `*Account Number:* ${bankData.accountNumber}\n` +
      `*Account Holder:* ${bankData.accountName}\n\n` +
      `Please note, only USDC and USDT are supported across **Base, BNB Smart Chain, and Polygon**. If any other token is deposited, reach out to customer support for assistance.`;

    await ctx.replyWithMarkdown(confirmationMessage, getMainMenu(true, true));

    // Log to Admin
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🔗 User ${userId} linked a bank account:\n\n` +
      `*Account Name:* ${wallet.bank.accountName}\n` +
      `*Bank Name:* ${wallet.bank.bankName}\n` +
      `*Account Number:* ****${wallet.bank.accountNumber.slice(-4)}`, { parse_mode: 'Markdown' });
    logger.info(`User ${userId} linked a bank account: ${JSON.stringify(wallet.bank)}`);

    // Acknowledge the Callback to Remove Loading State
    await ctx.answerCbQuery();
    ctx.scene.leave();
  } catch (error) {
    logger.error(`Error in confirm_bank_yes handler for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('❌ An error occurred while confirming your bank details. Please try again later.');
    await ctx.answerCbQuery();
    ctx.scene.leave();
  }
});

bankLinkingScene.action('confirm_bank_no', async (ctx) => {
  await ctx.replyWithMarkdown('⚠️ Let\'s try again.');

  // Restart the scene
  await ctx.scene.reenter();

  // Acknowledge the Callback to Remove Loading State
  await ctx.answerCbQuery();
});

bankLinkingScene.action('cancel_bank_linking', async (ctx) => {
  await ctx.replyWithMarkdown('❌ Bank linking process has been canceled.');

  // Clean Up Session Variables
  delete ctx.session.walletIndex;
  delete ctx.session.bankData;
  delete ctx.session.processType;

  // Acknowledge the Callback to Remove Loading State
  await ctx.answerCbQuery();
  ctx.scene.leave();
});

/**
 * =================== Send Message Scene ===================
 */
const sendMessageScene = new Scenes.WizardScene(
  'send_message_scene',
  // Step 1: Enter User ID
  async (ctx) => {
    await ctx.replyWithMarkdown('📩 Please enter the User ID you want to message:');
    return ctx.wizard.next();
  },
  // Step 2: Enter Message Content
  async (ctx) => {
    const userIdToMessage = ctx.message.text.trim();

    // Validate User ID
    if (!/^\d{5,15}$/.test(userIdToMessage)) {
      await ctx.replyWithMarkdown('❌ Invalid User ID. Please enter a valid numeric User ID (5-15 digits):');
      return;
    }

    // Check if User Exists
    const userDoc = await db.collection('users').doc(userIdToMessage).get();
    if (!userDoc.exists) {
      await ctx.replyWithMarkdown('❌ User ID not found. Please ensure the User ID is correct or try another one:');
      return;
    }

    ctx.session.userIdToMessage = userIdToMessage;
    await ctx.replyWithMarkdown('📝 Please enter the message you want to send to the user. You can also attach an image (receipt) with your message:');
    return ctx.wizard.next();
  },
  // Step 3: Send Message
  async (ctx) => {
    const userIdToMessage = ctx.session.userIdToMessage;
    const adminUserId = ctx.from.id.toString();

    if (ctx.message.photo) {
      // Handle Photo Message
      const photoArray = ctx.message.photo;
      const highestResolutionPhoto = photoArray[photoArray.length - 1];
      const fileId = highestResolutionPhoto.file_id;
      const caption = ctx.message.caption || '';

      try {
        await bot.telegram.sendPhoto(userIdToMessage, fileId, { caption: caption, parse_mode: 'Markdown' });
        await ctx.replyWithMarkdown('✅ Photo message sent successfully.');
        logger.info(`Admin ${adminUserId} sent photo message to user ${userIdToMessage}. Caption: ${caption}`);
      } catch (error) {
        logger.error(`Error sending photo to user ${userIdToMessage}: ${error.message}`);
        await ctx.replyWithMarkdown('⚠️ Error sending photo. Please ensure the User ID is correct and the user has not blocked the bot.');
      }
    } else if (ctx.message.text) {
      // Handle Text Message
      const messageContent = ctx.message.text.trim();

      if (!messageContent) {
        await ctx.reply('❌ Message content cannot be empty. Please enter a valid message:');
        return;
      }

      try {
        await bot.telegram.sendMessage(userIdToMessage, `📩 *Message from Admin:*\n\n${messageContent}`, { parse_mode: 'Markdown' });
        await ctx.replyWithMarkdown('✅ Text message sent successfully.');
        logger.info(`Admin ${adminUserId} sent text message to user ${userIdToMessage}: ${messageContent}`);
      } catch (error) {
        logger.error(`Error sending message to user ${userIdToMessage}: ${error.message}`);
        await ctx.replyWithMarkdown('⚠️ Error sending message. Please ensure the User ID is correct and the user has not blocked the bot.');
      }
    } else {
      await ctx.reply('❌ Unsupported message type. Please send text or a photo (receipt).');
    }

    // Reset Session Variables and Leave the Scene
    delete ctx.session.userIdToMessage;
    ctx.scene.leave();
  }
);

// =================== Register Scenes with Stage ===================
const stage = new Scenes.Stage();
stage.register(bankLinkingScene, sendMessageScene);

// =================== Apply Middlewares ===================
bot.use(session());
bot.use(stage.middleware());

// =================== Exchange Rate Fetching ===================
const SUPPORTED_ASSETS = ['USDC', 'USDT'];
let exchangeRates = {
  USDC: 0,
  USDT: 0
};

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
    // Optionally, retain previous rates or handle as needed
  }
}

// Initial fetch
fetchExchangeRates();

// Update Exchange Rates Every 5 Minutes
setInterval(fetchExchangeRates, 300000); // 5 minutes

// =================== Main Menu ===================
const getMainMenu = (walletExists, hasBankLinked) =>
  Markup.keyboard([
    [walletExists ? '💼 View Wallet' : '💼 Generate Wallet', hasBankLinked ? '⚙️ Settings' : '🏦 Link Bank Account'],
    ['💰 Transactions', 'ℹ️ Support', '📘 Learn About Base'],
    ['📈 View Current Rates'],
  ]).resize();

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

/**
 * Greets the user and provides the main menu.
 * @param {TelegrafContext} ctx - Telegraf context.
 */
async function greetUser(ctx) {
  const userId = ctx.from.id.toString();
  let userState;
  try {
    userState = await getUserState(userId);

    // If firstName is empty, update it from ctx.from.first_name
    if (!userState.firstName) {
      await db.collection('users').doc(userId).update({
        firstName: ctx.from.first_name || 'Valued User'
      });
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
    ? `👋 Hello, ${userState.firstName}!\n\nWelcome back to **DirectPay**. Here's what you can do next:\n\n`
    : `👋 Welcome, ${userState.firstName}!\n\nThank you for choosing **DirectPay**. Let's get you started:\n\n`;

  await ctx.replyWithMarkdown(greeting, getMainMenu(walletExists, hasBankLinked));
}

// =================== Generate Wallet Handler ===================
bot.hears('💼 Generate Wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    
    if (userState.wallets.length >= MAX_WALLETS) {
      return ctx.replyWithMarkdown(`⚠️ You have reached the maximum number of wallets (${MAX_WALLETS}). Please manage your existing wallets before adding new ones.`);
    }
    
    // Show pending message
    const pendingMessage = await ctx.replyWithMarkdown('🔄 *Generating Wallet...* Please wait a moment.');

    // Use Base as default chain
    const chain = 'Base';
    const walletAddress = await generateWallet(chain);

    // Update user state
    userState.wallets.push({
      address: walletAddress,
      chain: chain,
      supportedAssets: ['USDC', 'USDT'],
      bank: null,
      amount: 0
    });
    userState.walletAddresses.push(walletAddress);

    await updateUserState(userId, {
      wallets: userState.wallets,
      walletAddresses: userState.walletAddresses,
    });

    // Delete pending message and show wallet generation success message
    await ctx.deleteMessage(pendingMessage.message_id);
    const successMessage = await ctx.replyWithMarkdown(`✅ *Wallet Generated Successfully!*\n\n` +
      `*Supported Networks:* Base, BNB Smart Chain, Polygon (Matic)\n` +
      `*Supported Assets:* USDC, USDT\n\n` +
      `Kindly link a bank account to proceed. Your wallet address will be revealed once your bank details are confirmed. If you deposit any token other than USDC/USDT, please contact customer support to retrieve it.`);

    // Set walletIndex for immediate bank linking
    ctx.session.walletIndex = userState.wallets.length - 1;
    
    // Enter the Bank Linking Wizard Scene
    await ctx.scene.enter('bank_linking_scene');
  } catch (error) {
    logger.error(`Error generating wallet for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while generating your wallet. Please try again later.');
  }
});

// =================== View Wallet Handler ===================
bot.hears('💼 View Wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    
    if (userState.wallets.length === 0) {
      return ctx.replyWithMarkdown('❌ You have no wallets. Please generate a wallet first using the "💼 Generate Wallet" option.');
    }

    let message = `💼 *Your Wallets*:\n\n`;
    userState.wallets.forEach((wallet, index) => {
      message += `*Wallet ${index + 1}:*\n`;
      message += `• *Chain:* ${wallet.chain}\n`;
      message += `• *Bank Linked:* ${wallet.bank ? '✅ Yes' : '❌ No'}\n\n`;
    });

    await ctx.replyWithMarkdown(message);
  } catch (error) {
    logger.error(`Error handling View Wallet for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while fetching your wallets. Please try again later.');
  }
});

// =================== Settings Handler ===================
bot.hears('⚙️ Settings', async (ctx) => {
  await ctx.reply('⚙️ *Settings Menu*', getSettingsMenu());
});

/**
 * Generates the Settings Menu Inline Keyboard.
 * @returns {Markup} - Inline Keyboard Markup.
 */
const getSettingsMenu = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Generate New Wallet', 'settings_generate_wallet')],
    [Markup.button.callback('✏️ Edit Linked Bank Details', 'settings_edit_bank')],
    [Markup.button.callback('💬 Support', 'settings_support')],
    [Markup.button.callback('🔙 Back to Main Menu', 'settings_back_main')],
  ]);

// Handle "🔄 Generate New Wallet" in Settings
bot.action('settings_generate_wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    
    if (userState.wallets.length >= MAX_WALLETS) {
      return ctx.replyWithMarkdown(`⚠️ You have reached the maximum number of wallets (${MAX_WALLETS}). Please manage your existing wallets before adding new ones.`);
    }

    await bot.hears('💼 Generate Wallet')(ctx);

    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error handling Generate New Wallet in Settings for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while generating your wallet. Please try again later.');
    ctx.answerCbQuery();
  }
});

// Handle "✏️ Edit Linked Bank Details" in Settings
bot.action('settings_edit_bank', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    
    if (userState.wallets.length === 0) {
      return ctx.replyWithMarkdown('❌ You have no wallets. Please generate a wallet first using the "💼 Generate Wallet" option.');
    }

    // If only one wallet, proceed to edit bank
    if (userState.wallets.length === 1) {
      ctx.session.walletIndex = 0;
      await ctx.scene.enter('bank_linking_scene');
    } else {
      // Multiple wallets, prompt user to select which wallet to edit
      let keyboard = userState.wallets.map((wallet, index) => [
        Markup.button.callback(`Wallet ${index + 1} - ${wallet.chain}`, `select_wallet_edit_bank_${index}`)
      ]);
      await ctx.reply('Please select the wallet for which you want to edit the bank details:', Markup.inlineKeyboard(keyboard));
    }
    
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error handling Edit Linked Bank Details in Settings for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while editing your bank details. Please try again later.');
    ctx.answerCbQuery();
  }
});

// Handle Wallet Selection for Editing Bank Details
bot.action(/select_wallet_edit_bank_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);

  if (isNaN(walletIndex)) {
    await ctx.replyWithMarkdown('⚠️ Invalid wallet selection. Please try again.');
    return ctx.answerCbQuery();
  }

  ctx.session.walletIndex = walletIndex;
  await ctx.scene.enter('bank_linking_scene');
  ctx.answerCbQuery();
});

// Handle "💬 Support" in Settings
bot.action('settings_support', async (ctx) => {
  await ctx.replyWithMarkdown('🛠️ *Support Section*\n\nSelect an option below:', Markup.inlineKeyboard([
    [Markup.button.callback('❓ How It Works', 'support_how_it_works')],
    [Markup.button.callback('⚠️ Transaction Not Received', 'support_not_received')],
    [Markup.button.callback('💬 Contact Support', 'support_contact')],
  ]));
});

// Handle "🔙 Back to Main Menu" in Settings
bot.action('settings_back_main', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    const walletExists = userState.wallets.length > 0;
    const hasBankLinked = userState.wallets.some(wallet => wallet.bank);

    await ctx.replyWithMarkdown('Welcome back to the main menu!', getMainMenu(walletExists, hasBankLinked));
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error returning to main menu for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
    ctx.answerCbQuery();
  }
});

// =================== Support Handlers ===================

// Detailed Tutorials
const detailedTutorials = {
  how_it_works: `
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
  transaction_guide: `
**💰 Transaction Not Received?**

If you haven't received your transaction, follow these steps to troubleshoot:

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
   - If the issue persists after following the above steps, reach out to our support team at [@maxswap](https://t.me/maxcswap) with your transaction details for further assistance.
`,
  link_bank_tutorial: `
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
};

// =================== Learn About Base Handler ===================
bot.hears(/📘\s*Learn About Base/i, async (ctx) => {
  await sendBaseContent(ctx, 0, true);
});

const baseContent = [
  {
    title: 'Welcome to Base',
    text: 'Base is a secure, low-cost, and developer-friendly Ethereum Layer 2 network. It offers a seamless way to onboard into the world of decentralized applications.',
  },
  {
    title: 'Why Choose Base?',
    text: '- **Lower Fees**: Significantly reduced transaction costs.\n- **Faster Transactions**: Swift confirmation times.\n- **Secure**: Built on Ethereum’s robust security.\n- **Developer-Friendly**: Compatible with EVM tools and infrastructure.',
  },
  {
    title: 'Getting Started',
    text: 'To start using Base, you can bridge your assets from Ethereum to Base using the official bridge at [Bridge Assets to Base](https://base.org/bridge).',
  },
  {
    title: 'Learn More',
    text: 'Visit the official documentation at [Base Documentation](https://docs.base.org) for in-depth guides and resources.',
  },
];

/**
 * Sends Base content with pagination.
 * @param {TelegrafContext} ctx - Telegraf context.
 * @param {number} index - Current page index.
 * @param {boolean} isNew - Indicates if it's a new message or an edit.
 */
async function sendBaseContent(ctx, index, isNew = true) {
  const content = baseContent[index];
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
    // Store the message ID in session
    ctx.session.baseMessageId = sentMessage.message_id;
  } else {
    try {
      await ctx.editMessageText(`**${content.title}**\n\n${content.text}`, {
        parse_mode: 'Markdown',
        reply_markup: inlineKeyboard.reply_markup,
      });
    } catch (error) {
      // If editing message fails, send a new message and update session
      const sentMessage = await ctx.replyWithMarkdown(`**${content.title}**\n\n${content.text}`, inlineKeyboard);
      ctx.session.baseMessageId = sentMessage.message_id;
    }
  }
}

// Base Content Pagination
bot.action(/base_page_(\d+)/, async (ctx) => {
  const index = parseInt(ctx.match[1], 10);
  if (isNaN(index) || index < 0 || index >= baseContent.length) {
    return ctx.answerCbQuery('⚠️ Invalid page number.', { show_alert: true });
  }
  await sendBaseContent(ctx, index, false);
  ctx.answerCbQuery(); // Acknowledge the callback
});

// Exit Base Content
bot.action('exit_base', async (ctx) => {
  // Delete the message and clear session
  if (ctx.session.baseMessageId) {
    await ctx.deleteMessage(ctx.session.baseMessageId).catch(() => {});
    ctx.session.baseMessageId = null;
  }
  await ctx.replyWithMarkdown('Thank you for learning about Base!');
  ctx.answerCbQuery();
});

// =================== Support Handlers ===================
bot.hears(/ℹ️\s*Support/i, async (ctx) => {
  await ctx.replyWithMarkdown('🛠️ *Support Section*\n\nSelect an option below:', Markup.inlineKeyboard([
    [Markup.button.callback('❓ How It Works', 'support_how_it_works')],
    [Markup.button.callback('⚠️ Transaction Not Received', 'support_not_received')],
    [Markup.button.callback('💬 Contact Support', 'support_contact')],
  ]));
});

// Support Actions
bot.action('support_how_it_works', async (ctx) => {
  await ctx.replyWithMarkdown(detailedTutorials.how_it_works);
  ctx.answerCbQuery();
});

bot.action('support_not_received', async (ctx) => {
  await ctx.replyWithMarkdown(detailedTutorials.transaction_guide);
  ctx.answerCbQuery();
});

bot.action('support_contact', async (ctx) => {
  await ctx.replyWithMarkdown('You can contact our support team at [@your_support_username](https://t.me/your_support_username).');
  ctx.answerCbQuery();
});

// =================== Transactions Handler ===================
bot.hears(/💰\s*Transactions/i, async (ctx) => {
  const userId = ctx.from.id.toString();
  const pageSize = 5;
  let page = 1;
  let filter = 'all'; // default to show all transactions
  const filterOptions = ['all', 'Completed', 'Pending', 'Failed'];
  const assetOptions = ['USDC', 'USDT', 'All'];

  // Store current filter and page in session for subsequent calls
  if (ctx.session.transactionsPage) {
    page = ctx.session.transactionsPage;
    filter = ctx.session.transactionsFilter || 'all';
    asset = ctx.session.transactionsAsset || 'All';
  }

  try {
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
    
    let message = `💰 *Your Transaction History* (Page ${page}):\n\n`;
    transactions.forEach((doc, index) => {
      const tx = doc.data();
      message += `*${index + 1}.* *Reference ID:* \`${tx.referenceId}\`\n`;
      message += `   *Amount:* ${tx.amount} ${tx.asset} on ${tx.chain}\n`;
      message += `   *Status:* ${tx.status}\n`;
      message += `   *Payout:* ₦${tx.payout || 'N/A'}\n`;
      message += `   *Date:* ${new Date(tx.timestamp).toLocaleString()}\n\n`;
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

    // Store current state for next interactions
    ctx.session.transactionsPage = page;
    ctx.session.transactionsFilter = filter;
    ctx.session.transactionsAsset = asset;
  } catch (error) {
    logger.error(`Error fetching transactions for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ Unable to fetch transactions. Please try again later.');
  }
});

// Handle pagination and filtering callbacks
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
  ctx.session.transactionsPage = 1; // reset to first page when filter changes
  await ctx.answerCbQuery();
  await bot.hears('💰 Transactions')(ctx);
});

// =================== View Current Rates Handler ===================
bot.hears('📈 View Current Rates', async (ctx) => {
  let ratesMessage = '📈 *Current Exchange Rates:*\n\n';
  for (const [asset, rate] of Object.entries(exchangeRates)) {
    ratesMessage += `• *${asset}*: ₦${rate}\n`;
  }
  await ctx.replyWithMarkdown(ratesMessage, getMainMenu(true, true));
});

// =================== Admin Panel ===================

// Entry point for Admin Panel
bot.action('open_admin_panel', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    return ctx.reply('⚠️ Unauthorized access.');
  }

  // Reset session variables if necessary
  ctx.session.adminMessageId = null;

  const sentMessage = await ctx.reply('👨‍💼 **Admin Panel**\n\nSelect an option below:', getAdminMenu());
  ctx.session.adminMessageId = sentMessage.message_id;

  // Removed the inactivity timeout as per user request
});

/**
 * Generates the Admin Menu Inline Keyboard.
 * @returns {Markup} - Inline Keyboard Markup.
 */
const getAdminMenu = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('📋 View Recent Transactions', 'admin_view_transactions')],
    [Markup.button.callback('📨 Send Message to User', 'admin_send_message')],
    [Markup.button.callback('✅ Mark Transactions as Paid', 'admin_mark_paid')],
    [Markup.button.callback('👥 View All Users', 'admin_view_users')],
    [Markup.button.callback('📢 Broadcast Message', 'admin_broadcast_message')],
    [Markup.button.callback('🔙 Back to Main Menu', 'admin_back_to_main')],
  ]);

// Handle Admin Menu Actions
bot.action(/admin_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();

  if (!isAdmin(userId)) {
    return ctx.reply('⚠️ Unauthorized access.');
  }

  const action = ctx.match[1];

  switch (action) {
    case 'view_transactions':
      // Handle viewing transactions
      try {
        const transactionsSnapshot = await db.collection('transactions').orderBy('timestamp', 'desc').limit(10).get();

        if (transactionsSnapshot.empty) {
          await ctx.answerCbQuery('No transactions found.', { show_alert: true });
          return;
        }

        let message = '📋 **Recent Transactions**:\n\n';

        transactionsSnapshot.forEach((doc) => {
          const tx = doc.data();
          message += `*User ID:* ${tx.userId || 'N/A'}\n`;
          message += `*Reference ID:* \`${tx.referenceId || 'N/A'}\`\n`;
          message += `*Amount Deposited:* ${tx.amount || 'N/A'} ${tx.asset || 'N/A'}\n`;
          message += `*Status:* ${tx.status || 'Pending'}\n`;
          message += `*Chain:* ${tx.chain || 'N/A'}\n`;
          message += `*Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n\n`;
        });

        // Add a 'Back' button to return to the admin menu
        const inlineKeyboard = Markup.inlineKeyboard([
          [Markup.button.callback('🔙 Back to Admin Menu', 'admin_back_to_main')]
        ]);

        // Edit the admin panel message
        await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: inlineKeyboard.reply_markup });
        ctx.answerCbQuery();
      } catch (error) {
        logger.error(`Error fetching all transactions: ${error.message}`);
        await ctx.answerCbQuery('⚠️ Unable to fetch transactions.', { show_alert: true });
      }
      break;

    case 'send_message':
      // Handle sending messages
      try {
        const usersSnapshot = await db.collection('users').get();
        if (usersSnapshot.empty) {
          await ctx.replyWithMarkdown('⚠️ No users found to send messages.');
          return ctx.answerCbQuery();
        }

        await ctx.scene.enter('send_message_scene');
        ctx.answerCbQuery();
      } catch (error) {
        logger.error(`Error initiating send message: ${error.message}`);
        await ctx.replyWithMarkdown('⚠️ An error occurred while initiating the message. Please try again later.');
        ctx.answerCbQuery();
      }
      break;

    case 'mark_paid':
      // Handle marking transactions as paid as a backup for admin 
      try {
        const pendingTransactions = await db.collection('transactions').where('status', '==', 'Pending').get();
        if (pendingTransactions.empty) {
          await ctx.answerCbQuery('No pending transactions found.', { show_alert: true });
          return;
        }

        const batch = db.batch();
        pendingTransactions.forEach((transaction) => {
          const docRef = db.collection('transactions').doc(transaction.id);
          batch.update(docRef, { status: 'Paid' });
        });

        await batch.commit();

        // Notify users about their transactions being marked as paid
        pendingTransactions.forEach(async (transaction) => {
          const txData = transaction.data();
          try {
            const payout = txData.payout || 'N/A';
            const accountName = txData.bankDetails && txData.bankDetails.accountName ? txData.bankDetails.accountName : 'Valued User';

            await bot.telegram.sendMessage(
              txData.userId,
              `🎉 *Transaction Successful!*\n\n` +
              `Hello ${accountName},\n\n` +
              `Your DirectPay order has been completed. Here are the details of your order:\n\n` +
              `*Crypto amount:* ${txData.amount} ${txData.asset}\n` +
              `*Cash amount:* NGN ${payout}\n` +
              `*Network:* ${txData.chain}\n` +
              `*Date:* ${new Date(txData.timestamp).toLocaleString()}\n\n` + 
              `Thank you 💙.`,
              { parse_mode: 'Markdown' }
            );
            logger.info(`Notified user ${txData.userId} about paid transaction ${txData.referenceId}`);
          } catch (error) {
            logger.error(`Error notifying user ${txData.userId}: ${error.message}`);
          }
        });

        // Edit the admin panel message to confirm
        await ctx.editMessageText('✅ All pending transactions have been marked as paid.', { reply_markup: getAdminMenu() });
        ctx.answerCbQuery();
      } catch (error) {
        logger.error(`Error marking transactions as paid: ${error.message}`);
        await ctx.answerCbQuery('⚠️ Error marking transactions as paid. Please try again later.', { show_alert: true });
      }
      break;

    case 'view_users':
      // Handle viewing all users
      try {
        const usersSnapshot = await db.collection('users').get();

        if (usersSnapshot.empty) {
          await ctx.answerCbQuery('No users found.', { show_alert: true });
          return;
        }

        let message = '👥 **All Users**:\n\n';

        usersSnapshot.forEach((doc) => {
          const user = doc.data();
          message += `*User ID:* ${doc.id}\n`;
          message += `*First Name:* ${user.firstName || 'N/A'}\n`;
          message += `*Number of Wallets:* ${user.wallets.length}\n`;
          message += `*Bank Linked:* ${user.wallets.some(wallet => wallet.bank) ? 'Yes' : 'No'}\n\n`;
        });

        // Back to main menu
        const inlineKeyboard = Markup.inlineKeyboard([
          [Markup.button.callback('🔙 Back to Admin Menu', 'admin_back_to_main')]
        ]);

        // Edit the admin panel message
        await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: inlineKeyboard.reply_markup });
        ctx.answerCbQuery();
      } catch (error) {
        logger.error(`Error fetching all users: ${error.message}`);
        await ctx.answerCbQuery('⚠️ Unable to fetch users.', { show_alert: true });
      }
      break;

    case 'broadcast_message':
      // Handle sending broadcast messages to all users
      try {
        const usersSnapshot = await db.collection('users').get();
        if (usersSnapshot.empty) {
          await ctx.replyWithMarkdown('⚠️ No users available to broadcast.');
          return ctx.answerCbQuery();
        }

        await ctx.reply('📢 Please enter the message you want to broadcast to all users. You can also attach an image (receipt) with your message:');
        // Set state to indicate awaiting broadcast message
        // Implement a separate scene or handler if needed
        // For simplicity, this example does not implement it
        await ctx.answerCbQuery();
      } catch (error) {
        logger.error(`Error initiating broadcast message: ${error.message}`);
        await ctx.replyWithMarkdown('⚠️ An error occurred while initiating the broadcast. Please try again later.');
        ctx.answerCbQuery();
      }
      break;

    case 'back_to_main':
      // Return to the main menu
      await greetUser(ctx);
      // Delete the admin panel message
      if (ctx.session.adminMessageId) {
        await ctx.deleteMessage(ctx.session.adminMessageId).catch(() => {});
        ctx.session.adminMessageId = null;
      }
      ctx.answerCbQuery();
      break;

    default:
      await ctx.answerCbQuery('⚠️ Unknown action. Please select an option from the menu.', { show_alert: true });
  }
});

// =================== Webhook Handlers ===================

/**
 * =================== Paycrest Webhook Handler ===================
 */
app.post(WEBHOOK_PAYCREST_PATH, bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-paycrest-signature'];
  const rawBody = req.body; // Buffer

  if (!signature) {
    logger.error('No Paycrest signature found in headers.');
    return res.status(400).send('Signature missing.');
  }

  if (!verifyPaycrestSignature(rawBody, signature, PAYCREST_CLIENT_SECRET)) {
    logger.error('Invalid Paycrest signature.');
    return res.status(401).send('Invalid signature.');
  }

  let parsedBody;
  try {
    parsedBody = JSON.parse(rawBody.toString());
  } catch (error) {
    logger.error(`Failed to parse Paycrest webhook body: ${error.message}`);
    return res.status(400).send('Invalid JSON.');
  }

  const event = parsedBody.event;
  const data = parsedBody.data;

  // Log the received event for debugging purposes
  logger.info(`Received Paycrest event: ${event}`);

  try {
    // Extract common data
    const orderId = data.id;
    const status = data.status; 
    const amountPaid = parseFloat(data.amountPaid) || 0;
    const reference = data.reference;
    const returnAddress = data.returnAddress;

    // Fetch the transaction by Paycrest order ID
    const txSnapshot = await db.collection('transactions').where('paycrestOrderId', '==', orderId).limit(1).get();

    if (txSnapshot.empty) {
      logger.error(`No transaction found for Paycrest orderId: ${orderId}`);
      await bot.telegram.sendMessage(
        PERSONAL_CHAT_ID, 
        `❗️ No transaction found for Paycrest orderId: \`${orderId}\``, 
        { parse_mode: 'Markdown' }
      );
      return res.status(200).send('OK');
    }

    const txDoc = txSnapshot.docs[0];
    const txData = txDoc.data();
    const userId = txData.userId;
    const userFirstName = txData.firstName || 'Valued User';

    // Switch based on the 'event' field instead of 'status'
    switch (event) {
      case 'payment_order.pending':
        await bot.telegram.sendMessage(
          userId,
          `We are currently processing your order. Please wait for further updates.`, 
          { parse_mode: 'Markdown' }
        );

        // Log to admin
        await bot.telegram.sendMessage(
          PERSONAL_CHAT_ID, 
          `🔄 *Payment Order Pending*\n\n` +
          `*User:* ${userFirstName} (ID: ${userId})\n` +
          `*Reference ID:* ${reference}\n` +
          `*Amount Paid:* ₦${amountPaid}\n`, 
          { parse_mode: 'Markdown' }
        );
        break;

      case 'payment_order.settled':
        await bot.telegram.sendMessage(
          userId, 
          `🎉 *Funds Credited Successfully!*\n\n` +
          `Hello ${userFirstName},\n\n` +
          `Your DirectPay order has been completed. Here are the details of your order:\n\n` +
          `*Crypto amount:* ${txData.amount} ${txData.asset}\n` +
          `*Cash amount:* NGN ${txData.payout}\n` +
          `*Network:* ${txData.chain}\n` +
          `*Date:* ${new Date(txData.timestamp).toLocaleString()}\n\n` + 
          `Thank you 💙.`,
          { parse_mode: 'Markdown' }
        );

        // Update transaction status in Firestore
        await db.collection('transactions').doc(txDoc.id).update({ status: 'Completed' });

        // Log to admin
        await bot.telegram.sendMessage(
          PERSONAL_CHAT_ID, 
          `✅ *Payment Order Settled*\n\n` +
          `*User:* ${userFirstName} (ID: ${userId})\n` +
          `*Reference ID:* ${reference}\n` +
          `*Amount Paid:* ₦${amountPaid}\n`, 
          { parse_mode: 'Markdown' }
        );
        break;

      case 'payment_order.expired':
        await bot.telegram.sendMessage(
          userId, 
          `⚠️ *Your DirectPay order has expired.*\n\n` +
          `Hello ${userFirstName},\n\n` +
          `We regret to inform you that your DirectPay order with *Reference ID:* \`${reference}\` has expired.\n\n` +
          `*Reason:* We experienced issues while processing your order. Rest assured, the funds have been returned to your original payment method.\n\n` +
          `If you believe this is a mistake or need further assistance, please don't hesitate to contact our support team.\n\n` +
          `Thank you for your understanding.`,
          { parse_mode: 'Markdown' }
        );

        // Update transaction status in Firestore
        await db.collection('transactions').doc(txDoc.id).update({ status: 'Expired' });

        // Log to admin
        await bot.telegram.sendMessage(
          PERSONAL_CHAT_ID, 
          `⏰ *Payment Order Expired*\n\n` +
          `*User:* ${userFirstName} (ID: ${userId})\n` +
          `*Reference ID:* ${reference}\n`, 
          { parse_mode: 'Markdown' }
        );
        break;

      case 'payment_order.refunded':
        await bot.telegram.sendMessage(
          userId, 
          `❌ *Your DirectPay order has been refunded.*\n\n` +
          `Hello ${userFirstName},\n\n` +
          `We regret to inform you that your DirectPay order with *Reference ID:* \`${reference}\` has been refunded.\n\n` +
          `*Reason:* We experienced issues while processing your order. Rest assured, the funds have been returned to your original payment method.\n\n` +
          `If you believe this is a mistake or need further assistance, please don't hesitate to contact our support team.\n\n` +
          `Thank you for your understanding.`,
          { parse_mode: 'Markdown' }
        );

        // Update transaction status in Firestore
        await db.collection('transactions').doc(txDoc.id).update({ status: 'Refunded' });

        // Log to admin
        await bot.telegram.sendMessage(
          PERSONAL_CHAT_ID, 
          `🔄 *Payment Order Refunded*\n\n` +
          `*User:* ${userFirstName} (ID: ${userId})\n` +
          `*Reference ID:* ${reference}\n` +
          `*Amount Paid:* ₦${amountPaid}\n`, 
          { parse_mode: 'Markdown' }
        );
        break;

      default:
        logger.info(`Unhandled Paycrest event type: ${event}`);
    }

    res.status(200).send('OK');
  } catch (error) {
    logger.error(`Error processing Paycrest webhook: ${error.message}`);
    await bot.telegram.sendMessage(
      PERSONAL_CHAT_ID, 
      `❗️ Error processing Paycrest webhook: ${error.message}`, 
      { parse_mode: 'Markdown' }
    );
    res.status(500).send('Error');
  }
});

/**
 * Verifies Paycrest webhook signature.
 * @param {Buffer} requestBody - Raw request body.
 * @param {string} signatureHeader - Signature from headers.
 * @param {string} secretKey - Paycrest client secret.
 * @returns {boolean} - Verification result.
 */
function verifyPaycrestSignature(requestBody, signatureHeader, secretKey) {
  const hmac = crypto.createHmac('sha256', secretKey);
  hmac.update(requestBody);
  const calculatedSignature = hmac.digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(calculatedSignature), Buffer.from(signatureHeader));
  } catch (error) {
    // If buffer lengths are not equal, timingSafeEqual throws an error
    return false;
  }
}

/**
 * =================== Blockradar Webhook Handler ===================
 */
app.post(WEBHOOK_BLOCKRADAR_PATH, bodyParser.json(), async (req, res) => {
  try {
    const event = req.body;
    if (!event) {
      logger.error('No event data found in Blockradar webhook.');
      return res.status(400).send('No event data found.');
    }

    logger.info(`Received Blockradar webhook: ${JSON.stringify(event)}`);
    fs.appendFileSync(path.join(__dirname, 'webhook_logs.txt'), `${new Date().toISOString()} - ${JSON.stringify(event, null, 2)}\n`);

    // Extract common event data
    const eventType = event.event || 'Unknown Event';
    const walletAddress = event.data?.recipientAddress || 'N/A';
    const amount = parseFloat(event.data?.amount) || 0;
    const asset = event.data?.asset?.symbol || 'N/A';
    const transactionHash = event.data?.hash || 'N/A';
    const chainRaw = event.data?.blockchain?.name || 'N/A';
    const senderAddress = event.data?.senderAddress || 'N/A'; 
    
    // Normalize and map the chain name for ease
    const chainKey = chainMapping[chainRaw.toLowerCase()];
    if (!chainKey) {
      logger.error(`Unknown chain received in webhook: ${chainRaw}`);
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ Received deposit on unknown chain: \`${chainRaw}\``);
      return res.status(400).send('Unknown chain.');
    }

    const chain = chainKey;

    if (eventType === 'deposit.success') { 
      if (walletAddress === 'N/A') {
        logger.error('Webhook missing wallet address.');
        return res.status(400).send('Missing wallet address.');
      }

      // **Duplicate Check Start**
      const existingTxSnapshot = await db.collection('transactions').where('transactionHash', '==', transactionHash).get();
      if (!existingTxSnapshot.empty) {
        logger.info(`Transaction with hash ${transactionHash} already exists. Skipping.`);
        return res.status(200).send('OK');
      }
      // **Duplicate Check End**

      // Find user by wallet address
      const usersSnapshot = await db.collection('users').where('walletAddresses', 'array-contains', walletAddress).get();
      if (usersSnapshot.empty) {
        logger.warn(`No user found for wallet ${walletAddress}`);
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ No user found for wallet address: \`${walletAddress}\``);
        return res.status(200).send('OK');
      }

      const userDoc = usersSnapshot.docs[0];
      const userId = userDoc.id;
      const userState = userDoc.data();
      const wallet = userState.wallets.find((w) => w.address === walletAddress);

      if (!wallet || !wallet.bank) {
        await bot.telegram.sendMessage(userId, `💰 *Deposit Received:* ${amount} ${asset} on ${chainRaw}. Please link a bank account to proceed with payout.`, { parse_mode: 'Markdown' });
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ User ${userId} has received a deposit but hasn't linked a bank account.`, { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      }

      if (!['USDC', 'USDT'].includes(asset)) {
        await bot.telegram.sendMessage(userId, `⚠️ *Unsupported Asset Deposited:* ${amount} ${asset} on ${chainRaw}. Currently, only USDC and USDT are supported.`, { parse_mode: 'Markdown' });
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ User ${userId} deposited unsupported asset: ${asset}.`, { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      }

      // Use Blockradar's rate for display
      const blockradarRate = event.data?.rate || 0;
      // Use Paycrest rate for calculation with service fee deduction
      const paycrestRate = exchangeRates[asset] || 0;
      const serviceFeePercent = 0.5; // 0.5% service fee
      const ngnAmount = calculatePayoutWithFee(amount, paycrestRate, serviceFeePercent);

      const referenceId = generateReferenceId();
      const { bankName, accountNumber, accountName } = wallet.bank || { bankName: 'N/A', accountNumber: 'N/A', accountName: 'Valued User' };
      const userFirstName = userState.firstName || 'Valued User';

      const transactionRef = await db.collection('transactions').add({
        userId,
        walletAddress,
        chain: chainRaw,
        amount: amount,
        asset: asset,
        transactionHash: transactionHash,
        referenceId: referenceId,
        bankDetails: wallet.bank,
        payout: ngnAmount, // Store NGN payout after fee
        timestamp: new Date().toISOString(),
        status: 'Pending',
        paycrestOrderId: '', 
        messageId: null, 
        firstName: userFirstName 
      });

      // Alert User for deposit received
      const pendingMessage = await bot.telegram.sendMessage(userId,
        `🎉 *Deposit Received!*\n\n` +
        `*Amount:* ${amount} ${asset} on ${chainRaw}\n` +
        `*Reference ID:* \`${referenceId}\`\n` +
        `*Exchange Rate:* ₦${blockradarRate} per ${asset} (Blockradar)\n` + 
        `*Estimated Payout:* ₦${ngnAmount.toFixed(2)}\n` +
        `*Time:* ${new Date().toLocaleString()}\n` +
        `*Bank Details:*\n` +
        `  - *Account Name:* ${accountName}\n` +
        `  - *Bank:* ${bankName}\n` +
        `  - *Account Number:* ****${accountNumber.slice(-4)}\n` +
        `Your order is now pending processing. We will update you shortly once funds have been credited to your account.\n\n` +
        `Thank you for using *DirectPay*!`,
        { parse_mode: 'Markdown' }
      );

      await transactionRef.update({
        messageId: pendingMessage.message_id
      });

      // Notify admin
      const adminDepositMessage = `⚡️ *New Deposit Received*\n\n` +
        `*User ID:* ${userId}\n` +
        `*Amount:* ${amount} ${asset} on ${chainRaw}\n` +
        `*Exchange Rate:* ₦${blockradarRate} per ${asset} (Blockradar)\n` +
        `*Amount to be Paid:* ₦${ngnAmount.toFixed(2)}\n` +
        `*Time:* ${new Date().toLocaleString()}\n` +
        `*Bank Details:*\n` +
        `  - *Account Name:* ${accountName}\n` +
        `  - *Bank:* ${bankName}\n` +
        `  - *Account Number:* ****${accountNumber.slice(-4)}\n` +
        `*Transaction Hash:* \`${transactionHash}\`\n` +
        `*Reference ID:* ${referenceId}\n`;
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, adminDepositMessage, { parse_mode: 'Markdown' });

      res.status(200).send('OK');

    } else if (eventType === 'deposit.swept.success') {
      // Find the transaction by transaction hash
      const txSnapshot = await db.collection('transactions').where('transactionHash', '==', transactionHash).limit(1).get();
      if (txSnapshot.empty) {
        logger.error(`No transaction found for hash: ${transactionHash}`);
        return res.status(200).send('OK');
      }

      const txDoc = txSnapshot.docs[0];
      const txData = txDoc.data();
      
      // Check if this transaction has already been processed
      if (txData.status === 'Completed' || txData.status === 'Processing' || txData.status === 'Failed') {
        logger.info(`Transaction with hash ${transactionHash} has already been processed. Status: ${txData.status}`);
        return res.status(200).send('OK');
      }
      
      // Create Paycrest order and withdraw from Blockradar
      const paycrestMapping = mapToPaycrest(asset, chainRaw);
      if (!paycrestMapping) {
        logger.error('No Paycrest mapping for this asset/chain.');
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ No Paycrest mapping found for asset ${asset} on chain ${chainRaw}.`);
        return res.status(200).send('OK');
      }

      let paycrestOrder;
      try {
        paycrestOrder = await createPaycrestOrder(txData.userId, amount, asset, chainRaw, txData.bankDetails, senderAddress); 
        await txDoc.ref.update({ paycrestOrderId: paycrestOrder.id });
      } catch (err) {
        logger.error(`Error creating Paycrest order: ${err.message}`);
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error creating Paycrest order for user ${txData.userId}: ${err.message}`, { parse_mode: 'Markdown' });
        await txDoc.ref.update({ status: 'Failed' });

        const assuranceMessage = `⚠️ *Withdrawal Issue Detected*\n\n` +
          `We've encountered an issue processing your withdrawal. Rest assured, we are working on a refund which should reflect in your wallet within 3-5 minutes. We apologize for the inconvenience and appreciate your patience.\n\n` +
          `If you have any questions, please do not hesitate to contact our support team.`;
        await bot.telegram.editMessageText(txData.userId, txData.messageId, null, assuranceMessage, { parse_mode: 'Markdown' });

        return res.status(500).send('Paycrest order error');
      }

      const receiveAddress = paycrestOrder.receiveAddress;
      let blockradarAssetId;
      switch (asset) {
        case 'USDC':
          blockradarAssetId = chains[chain].assets['USDC'];
          break;
        case 'USDT':
          blockradarAssetId = chains[chain].assets['USDT'];
          break;
        default:
          throw new Error(`Unsupported asset: ${asset}`);
      }

      try {
        await withdrawFromBlockradar(chainRaw, blockradarAssetId, receiveAddress, amount, paycrestOrder.id, { userId: txData.userId, originalTxHash: transactionHash });
      } catch (err) {
        logger.error(`Error withdrawing from Blockradar: ${err.message}`);
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error withdrawing from Blockradar for user ${txData.userId}: ${err.message}`, { parse_mode: 'Markdown' });
        await txDoc.ref.update({ status: 'Failed' });

        const assuranceMessage = `⚠️ *Withdrawal Issue Detected*\n\n` +
          `We've encountered an issue processing your withdrawal. Rest assured, we are working on a refund which should reflect in your wallet within 3-5 minutes. We apologize for the inconvenience and appreciate your patience.\n\n` +
          `If you have any questions, please do not hesitate to contact our support team.`;
        await bot.telegram.editMessageText(txData.userId, txData.messageId, null, assuranceMessage, { parse_mode: 'Markdown' });

        return res.status(500).send('Blockradar withdrawal error');
      }

      // Update transaction status to 'Processing' since funds are now being moved
      await txDoc.ref.update({ status: 'Processing' });
      
      // Update user's message to confirm deposit has been swept
      const depositSweptMessage = `🎉 *Deposit Confirmed!*\n\n` +
        `*Amount:* ${amount} ${asset} on ${chainRaw}\n` +
        `*Reference ID:* \`${txData.referenceId}\`\n` +
        `*Transaction Hash:* \`${transactionHash}\`\n` + 
        `Your deposit has been successfully confirmed. We are now processing your payout.\n\n` +
        `Thank you for using *DirectPay*!`;
      await bot.telegram.editMessageText(txData.userId, txData.messageId, null, depositSweptMessage, { parse_mode: 'Markdown' });

      logger.info(`Deposit swept for user ${txData.userId}: Reference ID ${paycrestOrder.id}`);
      res.status(200).send('OK');
    }
  } catch (error) {
    logger.error(`Error processing Blockradar webhook: ${error.message}`);
    res.status(500).send('Error processing webhook');
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error processing Blockradar webhook: ${error.message}`);
  }
});

// =================== Shutdown Handlers ===================
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// =================== Start Express Server ===================
app.use(WEBHOOK_PATH, bodyParser.json());

app.post(WEBHOOK_PATH, bodyParser.json(), (req, res) => {
  if (!req.body) {
    logger.error('No body found in Telegram webhook request.');
    return res.status(400).send('No body found.');
  }

  logger.info(`Received Telegram update: ${JSON.stringify(req.body, null, 2)}`); // Debugging

  bot.handleUpdate(req.body, res);
});

// =================== Launch Bot without bot.launch() ===================
// Do NOT call bot.launch() when using webhooks with Express
// Instead, ensure the Express server is running and handling updates

// =================== Start Express Server ===================
const SERVER_PORT = PORT; // Use the PORT from environment variables

app.listen(SERVER_PORT, () => {
  logger.info(`Webhook server running on port ${SERVER_PORT}`);
});
