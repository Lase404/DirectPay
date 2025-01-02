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
    winston.format.printf(({ timestamp, level, message }) => {
      return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'bot.log', maxsize: 5242880, maxFiles: 5 }) // 5MB per file, keep last 5 files
  ],
});

// =================== Firebase Setup ===================
const serviceAccount = require('./directpay.json'); // Ensure this file is secured on the server
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
  WEBHOOK_DOMAIN,
  PORT = 4000,
  BLOCKRADAR_CLIENT_SECRET,
  BLOCKRADAR_BASE_API_KEY,
  BLOCKRADAR_BNB_API_KEY,
  BLOCKRADAR_POLYGON_API_KEY,
  MAX_WALLETS = 5, // Maximum number of wallets per user
} = process.env;

// =================== Validations ===================
const requiredEnvVars = [
  'BOT_TOKEN',
  'PAYCREST_API_KEY',
  'PAYCREST_CLIENT_SECRET',
  'WEBHOOK_DOMAIN',
  'PAYSTACK_API_KEY',
  'BLOCKRADAR_BASE_API_KEY',
  'BLOCKRADAR_BNB_API_KEY',
  'BLOCKRADAR_POLYGON_API_KEY',
  'BLOCKRADAR_CLIENT_SECRET',
  'PERSONAL_CHAT_ID',
];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  logger.error(`Missing required environment variables: ${missingVars.join(', ')}`);
  process.exit(1);
}

// =================== Initialize Express App ===================
const app = express();

// =================== Initialize Telegraf Bot ===================
const bot = new Telegraf(BOT_TOKEN);

// =================== Define Supported Banks ===================
const bankList = [
  { name: 'Access Bank', code: '044', aliases: ['access', 'access bank', 'accessb', 'access bank nigeria'], paycrestInstitutionCode: 'ABNGNGLA' },
  { name: 'Zenith Bank', code: '057', aliases: ['zenith', 'zenith bank', 'zenithb', 'zenith bank nigeria'], paycrestInstitutionCode: 'ZENITHGLA' },
  { name: 'First Bank', code: '214', aliases: ['first bank', 'firstbank', 'firstbank nigeria'], paycrestInstitutionCode: 'FBNNGNGS' },
  { name: 'GTBank', code: '058', aliases: ['gtbank', 'gt bank', 'gtbank nigeria'], paycrestInstitutionCode: 'GTBNGNGS' },
  { name: 'UBA', code: '033', aliases: ['uba', 'united bank for africa', 'uba nigeria'], paycrestInstitutionCode: 'UBANGNG0' },
  { name: 'Union Bank', code: '032', aliases: ['union bank', 'unionbank', 'union bank nigeria'], paycrestInstitutionCode: 'UNBNGNGS' },
  { name: 'Wema Bank', code: '035', aliases: ['wema', 'wema bank', 'wemab', 'wema bank nigeria'], paycrestInstitutionCode: 'WEMANGLA' },
  { name: 'Kuda Microfinance Bank', code: '50211', aliases: ['kuda', 'kuda bank', 'kudab', 'kuda bank nigeria'], paycrestInstitutionCode: 'KUDANGPC' },
  { name: 'OPay', code: '999992', aliases: ['opay', 'opay nigeria'], paycrestInstitutionCode: 'OPAYNGPC' },
  { name: 'PalmPay', code: '999991', aliases: ['palmpay', 'palmpay nigeria'], paycrestInstitutionCode: 'PALMNGPC' },
  { name: 'Paystack-Titan MFB', code: '999992', aliases: ['paystack', 'paystack mfb', 'paystack-titan mfb'], paycrestInstitutionCode: 'PAYTNGPC' },
  { name: 'Moniepoint MFB', code: '999993', aliases: ['moniepoint', 'moniepoint mfb', 'moniepoint nigeria'], paycrestInstitutionCode: 'MONINGPC' },
  { name: 'Safe Haven MFB', code: '999994', aliases: ['safe haven', 'safe haven mfb', 'safe haven nigeria'], paycrestInstitutionCode: 'SAHVNGPC' },
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
 * Calculates NGN payout based on exchange rate.
 * @param {string} asset - Asset symbol.
 * @param {number} amount - Amount of asset.
 * @returns {number} - Calculated NGN amount.
 */
function calculatePayout(asset, amount) {
  const rate = exchangeRates[asset];
  if (!rate) {
    throw new Error(`Unsupported asset received: ${asset}`);
  }
  return parseFloat((amount * rate).toFixed(2)); // Return as number
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
      // Notify admin about the missing institution code
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
 * Generates a transaction receipt message.
 * @param {object} txData - Transaction data.
 * @returns {string} - Receipt message.
 */
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

// =================== Define Scenes ===================

// [Define your scenes here, e.g., bankLinkingScene, sendMessageScene, receiptGenerationScene]
// Ensure each scene is properly defined and exported if necessary.

// Example: Bank Linking Scene
const bankLinkingScene = new Scenes.WizardScene(
  'bank_linking_scene',
  // Step 1: Select Bank
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const userState = await getUserState(userId);

    // Present list of banks as inline keyboard
    let keyboard = bankList.map(bank => {
      return [Markup.button.callback(bank.name, `select_bank_${bank.code}`)];
    });
    await ctx.reply('🏦 *Select Your Bank:*', Markup.inlineKeyboard(keyboard));
    return ctx.wizard.next();
  },
  // Step 2: Enter Account Number
  async (ctx) => {
    const selectedBankCode = ctx.match[1];
    if (!selectedBankCode) {
      await ctx.reply('❌ Invalid bank selection. Please try again.');
      return ctx.scene.leave();
    }

    ctx.session.selectedBankCode = selectedBankCode;
    await ctx.reply('🔢 Please enter your bank account number (10-10 digits):');
    return ctx.wizard.next();
  },
  // Step 3: Enter Account Name
  async (ctx) => {
    const accountNumber = ctx.message.text.trim();
    const bank = bankList.find(b => b.code === ctx.session.selectedBankCode);

    if (!bank) {
      await ctx.reply('❌ Bank not found. Please try again.');
      return ctx.scene.leave();
    }

    // Validate account number length (assuming 10 digits)
    if (!/^\d{10}$/.test(accountNumber)) {
      await ctx.reply('❌ Invalid account number format. Please enter a 10-digit account number:');
      return;
    }

    // Verify bank account via Paystack
    try {
      const verification = await verifyBankAccount(accountNumber, bank.code);
      if (verification.status !== true) {
        await ctx.reply('❌ Bank account verification failed. Please check your account number and try again:');
        return;
      }

      const accountName = verification.data.account_name;
      ctx.session.accountNumber = accountNumber;
      ctx.session.accountName = accountName;
      ctx.session.bankName = bank.name;

      // Update user's bank details in Firestore
      const userId = ctx.from.id.toString();
      const userState = await getUserState(userId);
      const walletIndex = ctx.session.walletIndex; // Assumes user is editing a specific wallet

      if (walletIndex === undefined || walletIndex === null || !userState.wallets[walletIndex]) {
        await ctx.reply('❌ Invalid wallet selection. Please try again.');
        return ctx.scene.leave();
      }

      userState.wallets[walletIndex].bank = {
        bankName: bank.name,
        accountNumber: accountNumber,
        accountName: accountName
      };

      // Update Firestore
      await updateUserState(userId, { wallets: userState.wallets });

      await ctx.reply(`✅ Bank account linked successfully!\n\n*Bank:* ${bank.name}\n*Account Name:* ${accountName}\n*Account Number:* ****${accountNumber.slice(-4)}`, { parse_mode: 'Markdown' });
      ctx.scene.leave();
    } catch (error) {
      logger.error(`Error verifying bank account for user ${ctx.from.id}: ${error.message}`);
      await ctx.reply('⚠️ An error occurred while verifying your bank account. Please try again later.');
      ctx.scene.leave();
    }
  }
);

// [Similarly, define sendMessageScene and receiptGenerationScene as per your requirements]

// Example: Send Message Scene
const sendMessageScene = new Scenes.WizardScene(
  'send_message_scene',
  // Step 1: Enter User ID
  async (ctx) => {
    await ctx.reply('📄 Please enter the numeric User ID you wish to message (5-15 digits):');
    return ctx.wizard.next();
  },
  // Step 2: Validate User ID
  async (ctx) => {
    const userIdToMessage = ctx.message.text.trim();
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
    await ctx.replyWithMarkdown('📝 Please enter the message you want to send to the user. You can also attach an image with your message:');
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
        await bot.telegram.sendPhoto(userIdToMessage, fileId, { caption: `📢 *Broadcast Message:*\n\n${caption}`, parse_mode: 'Markdown' });
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
        await bot.telegram.sendMessage(userIdToMessage, `📢 *Broadcast Message:*\n\n${messageContent}`, { parse_mode: 'Markdown' });
        await ctx.replyWithMarkdown('✅ Text message sent successfully.');
        logger.info(`Admin ${adminUserId} sent text message to user ${userIdToMessage}: ${messageContent}`);
      } catch (error) {
        logger.error(`Error sending message to user ${userIdToMessage}: ${error.message}`);
        await ctx.replyWithMarkdown('⚠️ Error sending message. Please ensure the User ID is correct and the user has not blocked the bot.');
      }
    } else {
      await ctx.reply('❌ Unsupported message type. Please send text or a photo.');
    }

    // Reset Session Variables and Leave the Scene
    delete ctx.session.userIdToMessage;
    ctx.scene.leave();
  }
);

// Example: Receipt Generation Scene
const receiptGenerationScene = new Scenes.WizardScene(
  'receipt_generation_scene',
  // Step 1: Select Wallet
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const userState = await getUserState(userId);

    if (userState.wallets.length === 0) {
      await ctx.replyWithMarkdown('❌ You have no wallets. Please generate a wallet first using the "💼 Generate Wallet" option.');
      return ctx.scene.leave();
    }

    // If only one wallet, proceed to generate receipt
    if (userState.wallets.length === 1) {
      ctx.session.walletIndex = 0;
      return ctx.wizard.next();
    }

    // Multiple wallets: Prompt user to select one
    let keyboard = userState.wallets.map((wallet, index) => [
      Markup.button.callback(`Wallet ${index + 1} - ${wallet.chain}`, `select_receipt_wallet_${index}`)
    ]);
    await ctx.reply('Please select the wallet for which you want to generate a transaction receipt:', Markup.inlineKeyboard(keyboard));
    return ctx.wizard.next();
  },
  // Step 2: Generate Receipt
  async (ctx) => {
    const userId = ctx.from.id.toString();
    let walletIndex;

    if (ctx.session.walletIndex === undefined || ctx.session.walletIndex === null) {
      const match = ctx.match[1];
      walletIndex = parseInt(ctx.match[1], 10);

      if (isNaN(walletIndex)) {
        await ctx.replyWithMarkdown('⚠️ Invalid wallet selection. Please try again.');
        return ctx.wizard.back();
      }

      ctx.session.walletIndex = walletIndex;
    } else {
      walletIndex = ctx.session.walletIndex;
    }

    try {
      const userState = await getUserState(userId);
      const wallet = userState.wallets[walletIndex];

      if (!wallet) {
        throw new Error('Wallet not found.');
      }

      // Fetch transactions related to this wallet
      const transactionsSnapshot = await db.collection('transactions')
        .where('walletAddress', '==', wallet.address)
        .orderBy('timestamp', 'desc')
        .limit(10)
        .get();

      if (transactionsSnapshot.empty) {
        return ctx.replyWithMarkdown('You have no transactions for this wallet.');
      }

      let receiptMessage = `🧾 *Transaction Receipt for Wallet ${walletIndex + 1} - ${wallet.chain}*\n\n`;
      transactionsSnapshot.forEach((doc) => {
        const tx = doc.data();
        receiptMessage += `*Reference ID:* \`${tx.referenceId || 'N/A'}\`\n`;
        receiptMessage += `*Amount:* ${tx.amount || 'N/A'} ${tx.asset || 'N/A'}\n`;
        receiptMessage += `*Status:* ${tx.status || 'Pending'}\n`;
        receiptMessage += `*Exchange Rate:* ₦${exchangeRates[tx.asset] || 'N/A'} per ${tx.asset || 'N/A'}\n`;
        receiptMessage += `*Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n`;
        receiptMessage += `*Chain:* ${tx.chain || 'N/A'}\n\n`;
      });

      await ctx.replyWithMarkdown(receiptMessage);
      ctx.scene.leave();
    } catch (error) {
      logger.error(`Error generating receipt for user ${userId}: ${error.message}`);
      await ctx.replyWithMarkdown('⚠️ An error occurred while generating the receipt. Please try again later.');
      ctx.scene.leave();
    }
  }
);

// =================== Register Scenes with Stage ===================
const stage = new Scenes.Stage([bankLinkingScene, sendMessageScene, receiptGenerationScene]);

// =================== Apply Middlewares ===================
bot.use(session());
bot.use(stage.middleware());

// =================== Exchange Rate Fetching ===================
const SUPPORTED_ASSETS = ['USDC', 'USDT'];
let exchangeRates = {
  USDC: 0,
  USDT: 0
};

/**
 * Fetches the exchange rate for a specific asset from Paycrest.
 * @param {string} asset - Asset symbol.
 * @returns {number} - Exchange rate.
 */
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

/**
 * Fetches exchange rates for all supported assets.
 */
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
const PAYCREST_RATE_UPDATE_INTERVAL = 5 * 60 * 1000; // 5 minutes in milliseconds
setInterval(fetchExchangeRates, PAYCREST_RATE_UPDATE_INTERVAL);

// =================== Main Menu ===================
const getMainMenu = (walletExists, hasBankLinked) =>
  Markup.keyboard([
    [walletExists ? '💼 View Wallet' : '💼 Generate Wallet', hasBankLinked ? '⚙️ Settings' : '🏦 Link Bank Account'],
    ['💰 Transactions', 'ℹ️ Support', '📘 Learn About Base'],
    ['📈 View Current Rates'], // Added Refresh Rates Button
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
    ? `👋 Hello, ${userState.firstName}!\n\nWelcome back to **DirectPay**, your gateway to seamless crypto transactions.\n\n💡 **Quick Start Guide:**\n1. **Add Your Bank Account**\n2. **Access Your Dedicated Wallet Address**\n3. **Send Stablecoins and Receive Cash Instantly**\n\nWe offer competitive rates and real-time updates to keep you informed. Your funds are secure, and you'll have cash in your account promptly!\n\nLet's get started!`
    : `👋 Welcome, ${userState.firstName}!\n\nThank you for choosing **DirectPay**. Let's embark on your crypto journey together. Use the menu below to get started.`;

  if (adminUser) {
    const sentMessage = await ctx.replyWithMarkdown(greeting, Markup.inlineKeyboard([
      [Markup.button.callback('🔧 Admin Panel', 'open_admin_panel')],
    ]));
    ctx.session.adminMessageId = sentMessage.message_id;
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
      return ctx.replyWithMarkdown(`⚠️ You have reached the maximum number of wallets (${MAX_WALLETS}). Please manage your existing wallets before adding new ones.`);
    }
    
    // Added exchange rate information during wallet generation
    let ratesMessage = '📈 *Current Exchange Rates*:\n\n';
    for (const [asset, rate] of Object.entries(exchangeRates)) {
      ratesMessage += `• *${asset}*: ₦${rate}\n`;
    }
    ratesMessage += `\nThese rates will be applied during your deposits and payouts.`;

    await ctx.replyWithMarkdown(ratesMessage);

    await ctx.reply('📂 *Select the network for which you want to generate a wallet:*', Markup.inlineKeyboard([
      [Markup.button.callback('Base', 'generate_wallet_Base')],
      [Markup.button.callback('Polygon', 'generate_wallet_Polygon')],
      [Markup.button.callback('BNB Smart Chain', 'generate_wallet_BNB Smart Chain')],
    ]));
  } catch (error) {
    logger.error(`Error handling Generate Wallet for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while generating your wallet. Please try again later.');
  }
});

// Handle Wallet Generation for Inline Buttons
bot.action(/generate_wallet_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const selectedChainRaw = ctx.match[1]; // e.g., 'Base', 'Polygon', 'BNB Smart Chain'

  // Normalize and map the selected chain
  const selectedChainKey = chainMapping[selectedChainRaw.toLowerCase()];
  if (!selectedChainKey) {
    await ctx.replyWithMarkdown('⚠️ Invalid network selection. Please try again.');
    return ctx.answerCbQuery(); // Acknowledge the callback to remove loading state
  }

  const chain = selectedChainKey;

  // Acknowledge the Callback to Remove Loading State
  await ctx.answerCbQuery();

  // Inform User That Wallet Generation Has Started
  const generatingMessage = await ctx.replyWithMarkdown(`🔄 Generating Wallet for *${chain}*... Please wait a moment.`);

  try {
    const walletAddress = await generateWallet(chain); // Implement this function based on your blockchain integration

    // Fetch Updated User State
    const userState = await getUserState(userId);

    if (userState.wallets.length >= MAX_WALLETS) {
      await ctx.replyWithMarkdown(`⚠️ You cannot generate more than ${MAX_WALLETS} wallets.`);
      await ctx.deleteMessage(generatingMessage.message_id);
      return;
    }

    // Add the New Wallet to User State
    userState.wallets.push({
      address: walletAddress || 'N/A',
      chain: chain || 'N/A',
      supportedAssets: chains[chain].supportedAssets ? [...chains[chain].supportedAssets] : [],
      bank: null,
      amount: 0 // Initialize amount if needed
    });

    // Also, Add the Wallet Address to walletAddresses Array
    const updatedWalletAddresses = userState.walletAddresses || [];
    updatedWalletAddresses.push(walletAddress);

    // Update User State in Firestore
    await updateUserState(userId, {
      wallets: userState.wallets,
      walletAddresses: updatedWalletAddresses,
    });

    // Log Wallet Generation
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `💼 Wallet generated for user ${userId} on ${chain}: ${walletAddress}`, { parse_mode: 'Markdown' });
    logger.info(`Wallet generated for user ${userId} on ${chain}: ${walletAddress}`);

    // Set walletIndex to the newly created wallet
    const newWalletIndex = userState.wallets.length - 1;
    ctx.session.walletIndex = newWalletIndex;

    // Delete the Generating Message
    await ctx.deleteMessage(generatingMessage.message_id);

    // Enter the Bank Linking Wizard Scene Immediately
    await ctx.scene.enter('bank_linking_scene');
  } catch (error) {
    logger.error(`Error generating wallet for user ${userId} on ${chain}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ There was an issue generating your wallet. Please try again later.');
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error generating wallet for user ${userId}: ${error.message}`, { parse_mode: 'Markdown' });
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

    // Implement Pagination
    const pageSize = 5; // Number of wallets per page
    const totalPages = Math.ceil(userState.wallets.length / pageSize);
    ctx.session.walletsPage = 1; // Initialize to first page

    const generateWalletPage = (page) => {
      const start = (page - 1) * pageSize;
      const end = start + pageSize;
      const wallets = userState.wallets.slice(start, end);

      let message = `💼 *Your Wallets* (Page ${page}/${totalPages}):\n\n`;
      wallets.forEach((wallet, index) => {
        const walletNumber = start + index + 1;
        message += `*Wallet ${walletNumber}:*\n`;
        message += `• *Chain:* ${wallet.chain}\n`;
        message += `• *Address:* \`${wallet.address}\`\n`;
        message += `• *Bank Linked:* ${wallet.bank ? '✅ Yes' : '❌ No'}\n\n`;
      });

      const navigationButtons = [];

      if (page > 1) {
        navigationButtons.push(Markup.button.callback('⬅️ Previous', `wallet_page_${page - 1}`));
      }
      if (page < totalPages) {
        navigationButtons.push(Markup.button.callback('Next ➡️', `wallet_page_${page + 1}`));
      }
      navigationButtons.push(Markup.button.callback('🔄 Refresh', `wallet_page_${page}`));

      const inlineKeyboard = Markup.inlineKeyboard([navigationButtons]);

      return { message, inlineKeyboard };
    };

    const { message, inlineKeyboard } = generateWalletPage(ctx.session.walletsPage);
    await ctx.replyWithMarkdown(message, inlineKeyboard);
  } catch (error) {
    logger.error(`Error handling View Wallet for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while fetching your wallets. Please try again later.');
  }
});

// Handle Wallet Page Navigation
bot.action(/wallet_page_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const requestedPage = parseInt(ctx.match[1], 10);

  try {
    const userState = await getUserState(userId);
    const pageSize = 5;
    const totalPages = Math.ceil(userState.wallets.length / pageSize);

    if (requestedPage < 1 || requestedPage > totalPages) {
      return ctx.answerCbQuery('⚠️ Invalid page number.', { show_alert: true });
    }

    ctx.session.walletsPage = requestedPage;

    const start = (requestedPage - 1) * pageSize;
    const end = start + pageSize;
    const wallets = userState.wallets.slice(start, end);

    let message = `💼 *Your Wallets* (Page ${requestedPage}/${totalPages}):\n\n`;
    wallets.forEach((wallet, index) => {
      const walletNumber = start + index + 1;
      message += `*Wallet ${walletNumber}:*\n`;
      message += `• *Chain:* ${wallet.chain}\n`;
      message += `• *Address:* \`${wallet.address}\`\n`;
      message += `• *Bank Linked:* ${wallet.bank ? '✅ Yes' : '❌ No'}\n\n`;
    });

    const navigationButtons = [];

    if (requestedPage > 1) {
      navigationButtons.push(Markup.button.callback('⬅️ Previous', `wallet_page_${requestedPage - 1}`));
    }
    if (requestedPage < totalPages) {
      navigationButtons.push(Markup.button.callback('Next ➡️', `wallet_page_${requestedPage + 1}`));
    }
    navigationButtons.push(Markup.button.callback('🔄 Refresh', `wallet_page_${requestedPage}`));

    const inlineKeyboard = Markup.inlineKeyboard([navigationButtons]);

    await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: inlineKeyboard.reply_markup });
    ctx.answerCbQuery(); // Acknowledge the callback
  } catch (error) {
    logger.error(`Error navigating wallet pages for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while navigating wallets. Please try again later.');
    ctx.answerCbQuery();
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
    [Markup.button.callback('🧾 Generate Transaction Receipt', 'settings_generate_receipt')],
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

    // Added exchange rate information during wallet generation
    let ratesMessage = '📈 *Current Exchange Rates*:\n\n';
    for (const [asset, rate] of Object.entries(exchangeRates)) {
      ratesMessage += `• *${asset}*: ₦${rate}\n`;
    }
    ratesMessage += `\nThese rates will be applied during your deposits and payouts.`;

    await ctx.replyWithMarkdown(ratesMessage);

    await ctx.reply('📂 *Select the network for which you want to generate a wallet:*', Markup.inlineKeyboard([
      [Markup.button.callback('Base', 'generate_wallet_Base')],
      [Markup.button.callback('Polygon', 'generate_wallet_Polygon')],
      [Markup.button.callback('BNB Smart Chain', 'generate_wallet_BNB Smart Chain')],
    ]));

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
  ctx.answerCbQuery();
});

// Handle "🧾 Generate Transaction Receipt" in Settings
bot.action('settings_generate_receipt', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    
    if (userState.wallets.length === 0) {
      return ctx.replyWithMarkdown('❌ You have no wallets. Please generate a wallet first using the "💼 Generate Wallet" option.');
    }

    // Prompt user to select which wallet to generate receipt for
    let keyboard = userState.wallets.map((wallet, index) => [
      Markup.button.callback(`Wallet ${index + 1} - ${wallet.chain}`, `select_receipt_wallet_${index}`)
    ]);
    await ctx.reply('Please select the wallet for which you want to generate a transaction receipt:', Markup.inlineKeyboard(keyboard));
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error handling Generate Transaction Receipt in Settings for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while generating the receipt. Please try again later.');
    ctx.answerCbQuery();
  }
});

// Handle Wallet Selection for Generating Receipt
bot.action(/select_receipt_wallet_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);

  if (isNaN(walletIndex)) {
    await ctx.replyWithMarkdown('⚠️ Invalid wallet selection. Please try again.');
    return ctx.answerCbQuery();
  }

  ctx.session.walletIndex = walletIndex;
  await ctx.scene.enter('receipt_generation_scene');
  ctx.answerCbQuery();
});

// =================== Support Handlers ===================

// Detailed Tutorials
const detailedTutorials = {
  how_it_works: `
**📘 How DirectPay Works**

1. **Generate Your Wallet:**
   - Navigate to the "💼 Generate Wallet" option.
   - Select your preferred network (Base, Polygon, BNB Smart Chain).
   - Receive a unique wallet address where you can receive crypto payments.

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
   - If the issue persists after following the above steps, reach out to our support team at [@maxcswap](https://t.me/maxcswap) with your transaction details for further assistance.
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
  try {
    const pageSize = 5; // Number of transactions per page
    const userState = await getUserState(userId);
    const transactionsSnapshot = await db.collection('transactions').where('userId', '==', userId).orderBy('timestamp', 'desc').limit(100).get(); // Fetch latest 100 transactions
    const transactionList = transactionsSnapshot.docs.map(doc => doc.data());

    if (transactionList.length === 0) {
      return ctx.replyWithMarkdown('❌ You have no transactions.');
    }

    // Implement Pagination
    const totalPages = Math.ceil(transactionList.length / pageSize);
    ctx.session.transactionsPage = 1; // Initialize to first page

    const generateTransactionPage = (page) => {
      const start = (page - 1) * pageSize;
      const end = start + pageSize;
      const transactions = transactionList.slice(start, end);

      let message = `💰 *Your Transactions* (Page ${page}/${totalPages}):\n\n`;
      transactions.forEach((tx, index) => {
        message += `*Transaction ${start + index + 1}:*\n`;
        message += `• *Reference ID:* \`${tx.referenceId || 'N/A'}\`\n`;
        message += `• *Amount:* ${tx.amount || 'N/A'} ${tx.asset || 'N/A'}\n`;
        message += `• *Status:* ${tx.status || 'Pending'}\n`;
        message += `• *Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n`;
        message += `• *Chain:* ${tx.chain || 'N/A'}\n\n`;
      });

      const navigationButtons = [];

      if (page > 1) {
        navigationButtons.push(Markup.button.callback('⬅️ Previous', `transaction_page_${page - 1}`));
      }
      if (page < totalPages) {
        navigationButtons.push(Markup.button.callback('Next ➡️', `transaction_page_${page + 1}`));
      }
      navigationButtons.push(Markup.button.callback('🔄 Refresh', `transaction_page_${page}`));

      const inlineKeyboard = Markup.inlineKeyboard([navigationButtons]);

      return { message, inlineKeyboard };
    };

    const { message, inlineKeyboard } = generateTransactionPage(ctx.session.transactionsPage);
    await ctx.replyWithMarkdown(message, inlineKeyboard);
  } catch (error) {
    logger.error(`Error fetching transactions for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ Unable to fetch transactions. Please try again later.');
  }
});

// Transaction Page Navigation
bot.action(/transaction_page_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const requestedPage = parseInt(ctx.match[1], 10);

  try {
    const pageSize = 5;
    const transactionsSnapshot = await db.collection('transactions').where('userId', '==', userId).orderBy('timestamp', 'desc').limit(100).get();
    const transactionList = transactionsSnapshot.docs.map(doc => doc.data());
    const totalPages = Math.ceil(transactionList.length / pageSize);

    if (requestedPage < 1 || requestedPage > totalPages) {
      return ctx.answerCbQuery('⚠️ Invalid page number.', { show_alert: true });
    }

    ctx.session.transactionsPage = requestedPage;

    const start = (requestedPage - 1) * pageSize;
    const end = start + pageSize;
    const transactions = transactionList.slice(start, end);

    let message = `💰 *Your Transactions* (Page ${requestedPage}/${totalPages}):\n\n`;
    transactions.forEach((tx, index) => {
      message += `*Transaction ${start + index + 1}:*\n`;
      message += `• *Reference ID:* \`${tx.referenceId || 'N/A'}\`\n`;
      message += `• *Amount:* ${tx.amount || 'N/A'} ${tx.asset || 'N/A'}\n`;
      message += `• *Status:* ${tx.status || 'Pending'}\n`;
      message += `• *Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n`;
      message += `• *Chain:* ${tx.chain || 'N/A'}\n\n`;
    });

    const navigationButtons = [];

    if (requestedPage > 1) {
      navigationButtons.push(Markup.button.callback('⬅️ Previous', `transaction_page_${requestedPage - 1}`));
    }
    if (requestedPage < totalPages) {
      navigationButtons.push(Markup.button.callback('Next ➡️', `transaction_page_${requestedPage + 1}`));
    }
    navigationButtons.push(Markup.button.callback('🔄 Refresh', `transaction_page_${requestedPage}`));

    const inlineKeyboard = Markup.inlineKeyboard([navigationButtons]);

    await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: inlineKeyboard.reply_markup });
    ctx.answerCbQuery(); // Acknowledge the callback
  } catch (error) {
    logger.error(`Error navigating transaction pages for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while navigating transactions. Please try again later.');
    ctx.answerCbQuery();
  }
});

// =================== Admin Panel ===================

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
              `*Reference ID:* \`${txData.referenceId || 'N/A'}\`\n` +
              `*Amount Paid:* ${txData.amount} ${txData.asset}\n` +
              `*Bank:* ${txData.bankDetails.bankName || 'N/A'}\n` +
              `*Account Name:* ${accountName}\n` +
              `*Account Number:* ****${txData.bankDetails.accountNumber.slice(-4)}\n` +
              `*Payout (NGN):* ₦${payout}\n\n` +
              `🔹 *Chain:* ${txData.chain}\n` +
              `*Date:* ${new Date(txData.timestamp).toLocaleString()}\n`,
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

        // Initiate broadcast message collection
        ctx.session.awaitingBroadcastMessage = true;
        await ctx.replyWithMarkdown('📢 Please enter the message you want to broadcast to all users. You can also attach an image with your message:');
        await ctx.answerCbQuery();
      } catch (error) {
        logger.error(`Error initiating broadcast message: ${error.message}`);
        await ctx.replyWithMarkdown('⚠️ An error occurred while initiating the broadcast. Please try again later.');
        ctx.answerCbQuery();
      }
      break;

    case 'admin_back_to_main':
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

// =================== Handle Broadcast Message (After Admin inputs message) ===================
bot.on('message', async (ctx, next) => {
  const userId = ctx.from.id.toString();
  if (isAdmin(userId) && ctx.session.awaitingBroadcastMessage) {
    const messageContent = ctx.message.text ? ctx.message.text.trim() : '';
    const photo = ctx.message.photo;

    if (!messageContent && !photo) {
      await ctx.replyWithMarkdown('❌ Message cannot be empty. Please enter a valid message or attach a photo.');
      return;
    }

    const usersSnapshot = await db.collection('users').get();
    if (usersSnapshot.empty) {
      await ctx.replyWithMarkdown('⚠️ No users found to send the broadcast message.');
      ctx.session.awaitingBroadcastMessage = false;
      return;
    }

    const sendPromises = [];

    usersSnapshot.forEach((doc) => {
      const userId = doc.id;
      if (photo) {
        const highestResolutionPhoto = photo[photo.length - 1];
        const fileId = highestResolutionPhoto.file_id;
        const caption = ctx.message.caption || '';

        sendPromises.push(
          bot.telegram.sendPhoto(userId, fileId, { caption: `📢 *Broadcast Message:*\n\n${caption}`, parse_mode: 'Markdown' })
        );
      } else if (messageContent) {
        sendPromises.push(
          bot.telegram.sendMessage(userId, `📢 *Broadcast Message:*\n\n${messageContent}`, { parse_mode: 'Markdown' })
        );
      }
    });

    try {
      await Promise.all(sendPromises);
      await ctx.replyWithMarkdown('✅ Broadcast message sent to all users.');
      logger.info(`Admin ${userId} sent a broadcast message: "${messageContent}" to ${usersSnapshot.size} users.`);
    } catch (error) {
      logger.error(`Error sending broadcast message: ${error.message}`);
      await ctx.replyWithMarkdown('⚠️ An error occurred while sending the broadcast message. Please try again later.');
    }

    ctx.session.awaitingBroadcastMessage = false;
  } else {
    return next();
  }
});

// =================== Admin Panel Actions ===================

// [Implement additional admin actions if necessary]

// =================== Verify Paycrest Signature ===================

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

// =================== Paycrest Webhook Handler ===================
app.post('/webhook/paycrest', express.raw({ type: '*/*' }), async (req, res) => {
  try {
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
            `⏳ *Your DirectPay order is pending processing.*\n\n` +
            `*Reference ID:* \`${reference}\`\n` +
            `*Amount:* ₦${amountPaid}\n` +
            `*Status:* Pending\n\n` +
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
            `*Cash amount:* NGN ${amountPaid}\n` +
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
  } catch (error) {
    // Outer catch
    logger.error(`Error in Paycrest webhook handler: ${error.message}`);
    await bot.telegram.sendMessage(
      PERSONAL_CHAT_ID,
      `❗️ Error in Paycrest webhook handler: ${error.message}`,
      { parse_mode: 'Markdown' }
    );
    res.status(500).send('Error');
  }
});

// =================== Verify Blockradar Signature ===================

/**
 * Verifies Blockradar webhook signature.
 * @param {Buffer} requestBody - Raw request body.
 * @param {string} signatureHeader - Signature from headers.
 * @param {string} secretKey - Blockradar client secret.
 * @returns {boolean} - Verification result.
 */
function verifyBlockradarSignature(requestBody, signatureHeader, secretKey) {
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
// =================== Blockradar Webhook Handler ===================
app.post('/webhook/blockradar', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const signature = req.headers['x-blockradar-signature']; // Adjust based on actual header
    const rawBody = req.body; // Buffer

    if (!signature) {
      logger.error('No Blockradar signature found in headers.');
      return res.status(400).send('Signature missing.');
    }

    if (!verifyBlockradarSignature(rawBody, signature, BLOCKRADAR_CLIENT_SECRET)) {
      logger.error('Invalid Blockradar signature.');
      return res.status(401).send('Invalid signature.');
    }

    let parsedBody;
    try {
      parsedBody = JSON.parse(rawBody.toString());
    } catch (error) {
      logger.error(`Failed to parse Blockradar webhook body: ${error.message}`);
      return res.status(400).send('Invalid JSON.');
    }

    const event = parsedBody.type; // Assuming 'type' is the event type
    const data = parsedBody.data;

    // Log the received event for debugging purposes
    logger.info(`Received Blockradar event: ${event}`);

    // Use a try block to handle event logic
    try {
      const eventType = event || 'Unknown Event';
      const walletAddress = data?.recipientAddress || 'N/A';
      const amount = parseFloat(data?.amount) || 0;
      const asset = data?.asset?.symbol || 'N/A';
      const transactionHash = data?.hash || 'N/A';
      const chainRaw = data?.blockchain?.name || 'N/A';
      const senderAddress = data?.senderAddress || 'N/A';

      // Normalize chain name
      const chainKey = chainMapping[chainRaw.toLowerCase()];
      if (!chainKey) {
        logger.error(`Unknown chain received in Blockradar webhook: ${chainRaw}`);
        await bot.telegram.sendMessage(
          PERSONAL_CHAT_ID, 
          `⚠️ Received deposit on unknown chain: \`${chainRaw}\``
        );
        return res.status(400).send('Unknown chain.');
      }
      const chain = chainKey;

      if (eventType === 'deposit.success') {
        // 1. Duplicate check
        const existingTxSnapshot = await db
          .collection('transactions')
          .where('transactionHash', '==', transactionHash)
          .get();
        if (!existingTxSnapshot.empty) {
          logger.info(`Transaction with hash ${transactionHash} already exists. Skipping.`);
          return res.status(200).send('OK');
        }

        // 2. Find user by wallet address
        if (walletAddress === 'N/A') {
          logger.error('Blockradar webhook missing wallet address.');
          return res.status(400).send('Missing wallet address.');
        }
        const usersSnapshot = await db
          .collection('users')
          .where('walletAddresses', 'array-contains', walletAddress)
          .get();

        if (usersSnapshot.empty) {
          logger.warn(`No user found for wallet address ${walletAddress}`);
          await bot.telegram.sendMessage(
            PERSONAL_CHAT_ID,
            `⚠️ No user found for wallet address: \`${walletAddress}\``,
            { parse_mode: 'Markdown' }
          );
          return res.status(200).send('OK');
        }

        const userDoc = usersSnapshot.docs[0];
        const userId = userDoc.id;
        const userState = userDoc.data();
        const wallet = userState.wallets.find((w) => w.address === walletAddress);

        // 3. Check if the user’s wallet is linked to a bank
        if (!wallet || !wallet.bank) {
          await bot.telegram.sendMessage(
            userId,
            `💰 *Deposit Received:* ${amount} ${asset} on ${chainRaw}.\n\nPlease link a bank account to receive your payout securely.`,
            { parse_mode: 'Markdown' }
          );
          await bot.telegram.sendMessage(
            PERSONAL_CHAT_ID,
            `⚠️ User ${userId} received a deposit but hasn't linked a bank account.`,
            { parse_mode: 'Markdown' }
          );
          return res.status(200).send('OK');
        }

        // 4. Only support USDC/USDT
        if (!['USDC', 'USDT'].includes(asset)) {
          await bot.telegram.sendMessage(
            userId,
            `⚠️ *Unsupported Asset Deposited:* ${asset}.\n\nCurrently, only *USDC* and *USDT* are supported. Please contact support if you believe this is an error.`,
            { parse_mode: 'Markdown' }
          );
          await bot.telegram.sendMessage(
            PERSONAL_CHAT_ID,
            `⚠️ User ${userId} deposited unsupported asset: ${asset}.`,
            { parse_mode: 'Markdown' }
          );
          return res.status(200).send('OK');
        }

        // 5. Fetch exchange rate and compute NGN payout
        const rate = exchangeRates[asset];
        if (!rate) {
          throw new Error(`Exchange rate for ${asset} not available.`);
        }
        const ngnAmount = calculatePayout(asset, amount);

        // 6. Create a transaction document
        const referenceId = generateReferenceId();
        const bankName = wallet.bank.bankName || 'N/A';
        const bankAccount = wallet.bank.accountNumber || 'N/A';
        const accountName = wallet.bank.accountName || 'Valued User';
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
          payout: ngnAmount,
          timestamp: new Date().toISOString(),
          status: 'Processing',
          paycrestOrderId: '',
          messageId: null,
          firstName: userFirstName
        });

        // 7. Inform the user (pending)
        const pendingMessage = await bot.telegram.sendMessage(
          userId,
          `🎉 *Deposit Received!*\n\n` +
            `*Reference ID:* \`${referenceId}\`\n` +
            `*Amount Deposited:* ${amount} ${asset}\n` +
            `*Exchange Rate:* ₦${rate} per ${asset}\n` +
            `*Network:* ${chainRaw}\n\n` +
            `🔄 *Your order has begun processing!* ⏳\n\n` +
            `We are converting your crypto to NGN at the current rate of ₦${rate} per ${asset}. Your cash will be credited to your linked bank account shortly.\n\n` +
            `Thank you for using *DirectPay*!`,
          { parse_mode: 'Markdown' }
        );

        await transactionRef.update({ messageId: pendingMessage.message_id });

        // 8. Notify admin
        const adminDepositMessage = `⚡️ *New Deposit Received*\n\n` +
          `*User ID:* ${userId}\n` +
          `*Amount Deposited:* ${amount} ${asset}\n` +
          `*Exchange Rate:* ₦${rate} per ${asset}\n` +
          `*Amount to be Paid:* ₦${ngnAmount}\n` +
          `*Time:* ${new Date().toLocaleString()}\n` +
          `*Bank Details:*\n` +
          `  - *Account Name:* ${accountName}\n` +
          `  - *Bank Name:* ${bankName}\n` +
          `  - *Account Number:* ****${bankAccount.slice(-4)}\n` +
          `*Chain:* ${chainRaw}\n` +
          `*Transaction Hash:* \`${transactionHash}\`\n` +
          `*Reference ID:* ${referenceId}\n`;
        await bot.telegram.sendMessage(
          PERSONAL_CHAT_ID,
          adminDepositMessage,
          { parse_mode: 'Markdown' }
        );

        // 9. Create a Paycrest order
        const paycrestMapping = mapToPaycrest(asset, chainRaw);
        if (!paycrestMapping) {
          logger.error('No Paycrest mapping for this asset/chain.');
          await bot.telegram.sendMessage(
            PERSONAL_CHAT_ID,
            `⚠️ No Paycrest mapping found for asset ${asset} on chain ${chainRaw}.`
          );
          return res.status(200).send('OK');
        }

        let paycrestOrder;
        try {
          paycrestOrder = await createPaycrestOrder(
            userId,
            amount,
            asset,
            chainRaw,
            wallet.bank,
            senderAddress
          );
          await transactionRef.update({ paycrestOrderId: paycrestOrder.id });
        } catch (err) {
          logger.error(`Error creating Paycrest order for user ${userId}: ${err.message}`);
          await bot.telegram.sendMessage(
            PERSONAL_CHAT_ID,
            `❗️ Error creating Paycrest order for user ${userId}: ${err.message}`,
            { parse_mode: 'Markdown' }
          );
          await transactionRef.update({ status: 'Failed' });

          const failureMessage = `Hello ${userFirstName},\n\n` +
            `⚠️ *Your DirectPay order has failed to process.*\n\n` +
            `Please contact our support team for assistance.`;
          await bot.telegram.editMessageText(
            userId,
            pendingMessage.message_id,
            null,
            failureMessage,
            { parse_mode: 'Markdown' }
          );
          return res.status(500).send('Paycrest order error');
        }

        // 10. Withdraw from Blockradar to Paycrest
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
          await withdrawFromBlockradar(
            chainRaw,
            blockradarAssetId,
            paycrestOrder.receiveAddress,
            amount,
            paycrestOrder.id,
            { userId, originalTxHash: transactionHash }
          );
        } catch (err) {
          logger.error(
            `Error withdrawing from Blockradar for user ${userId}: ${
              err.response ? err.response.data.message : err.message
            }`
          );
          await bot.telegram.sendMessage(
            PERSONAL_CHAT_ID,
            `❗️ Error withdrawing from Blockradar for user ${userId}: ${
              err.response ? err.response.data.message : err.message
            }`,
            { parse_mode: 'Markdown' }
          );
          await transactionRef.update({ status: 'Failed' });

          const failureMessage = `Hello ${userFirstName},\n\n` +
            `⚠️ *Your DirectPay order has failed to process.*\n\n` +
            `Please contact our support team for assistance.`;
          await bot.telegram.editMessageText(
            userId,
            pendingMessage.message_id,
            null,
            failureMessage,
            { parse_mode: 'Markdown' }
          );
          return res.status(500).send('Blockradar withdrawal error');
        }

        // Finally, set status to 'Pending' while off-ramp completes
        await transactionRef.update({ status: 'Pending' });

        logger.info(`Transaction stored for user ${userId}: Reference ID ${paycrestOrder.id}`);
        res.status(200).send('OK');
      } else {
        // If the event type is not handled above:
        logger.warn(`Unhandled Blockradar webhook event type: ${eventType}`);
        res.status(200).send('Unhandled event type.');
      }
    } catch (error) {
      logger.error(`Error processing Blockradar webhook: ${error.message}`);
      res.status(500).send('Error processing webhook');
      await bot.telegram.sendMessage(
        PERSONAL_CHAT_ID,
        `❗️ Error processing Blockradar webhook: ${error.message}`,
        { parse_mode: 'Markdown' }
      );
    }
  } catch (error) {
    logger.error(`Error processing Blockradar webhook: ${error.message}`);
    res.status(500).send('Error processing webhook');
    await bot.telegram.sendMessage(
      PERSONAL_CHAT_ID,
      `❗️ Error processing Blockradar webhook: ${error.message}`,
      { parse_mode: 'Markdown' }
    );
  }
});

// =================== Shutdown Handlers ===================
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// =================== Start Express Server ===================
app.use(bodyParser.json());

app.listen(PORT, () => {
  logger.info(`Express server listening on port ${PORT}`);
});

// =================== Additional Helper Functions ===================

/**
 * Generates a wallet address for the specified chain.
 * Implement this function based on your blockchain integration.
 * @param {string} chain - Name of the blockchain network.
 * @returns {string} - Generated wallet address.
 */
async function generateWallet(chain) {
  // Placeholder implementation. Replace with actual wallet generation logic.
  // This could involve interacting with a blockchain SDK or API.
  // For example purposes, we'll return a dummy address.
  return `0x${crypto.randomBytes(20).toString('hex')}`;
}
