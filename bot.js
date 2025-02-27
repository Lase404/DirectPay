/*****************************************
 *         Import Dependencies
 *****************************************/
const express = require('express');
const { Telegraf, Markup, Scenes, session } = require('telegraf');
const admin = require('firebase-admin');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const winston = require('winston');
const bodyParser = require('body-parser');
const sharp = require('sharp');
const requestIp = require('request-ip');
require('dotenv').config();

/*****************************************
 *         Logger Setup
 *****************************************/
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
    new winston.transports.File({ filename: 'bot.log', maxsize: 5242880, maxFiles: 5 })
  ],
});

/*****************************************
 *         Firebase Setup
 *****************************************/
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

/*****************************************
 *        Environment Variables
 *****************************************/
const {
  BOT_TOKEN,
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

if (!BOT_TOKEN || !PAYCREST_API_KEY || !PAYCREST_CLIENT_SECRET || !WEBHOOK_DOMAIN || !PAYSTACK_API_KEY) {
  logger.error('Missing required environment variables. Please check your .env file.');
  process.exit(1);
}

/*****************************************
 *          Image Paths
 *****************************************/
// These can be file paths or file_ids, adjust accordingly
const WALLET_GENERATED_IMAGE = './wallet_generated_base.png';
const DEPOSIT_SUCCESS_IMAGE = './deposit_success.png';
const PAYOUT_SUCCESS_IMAGE = './payout_success.png';
const ERROR_IMAGE = './error.png';

/*****************************************
 *         Initialize Express & Bot
 *****************************************/
const app = express();
const bot = new Telegraf(BOT_TOKEN);

/*****************************************
 *    Supported Banks & Chains
 *****************************************/
const bankList = [
  { name: 'Access Bank', code: '044', aliases: ['access', 'access bank', 'accessb', 'access bank nigeria'], paycrestInstitutionCode: 'ABNGNGLA' },
  { name: 'Wema Bank', code: '035', aliases: ['wema', 'wema bank', 'wemab', 'wema bank nigeria'], paycrestInstitutionCode: 'WEMANGLA' },
  { name: 'Kuda Microfinance Bank', code: '50211', aliases: ['kuda', 'kuda bank'], paycrestInstitutionCode: 'KUDANGPC' },
  { name: 'OPay', code: '999992', aliases: ['opay'], paycrestInstitutionCode: 'OPAYNGPC' },
  { name: 'PalmPay', code: '999991', aliases: ['palmpay'], paycrestInstitutionCode: 'PALMNGPC' },
  { name: 'Paystack-Titan MFB', code: '999992', aliases: ['paystack', 'paystack-titan mfb'], paycrestInstitutionCode: 'PAYTNGPC' },
  { name: 'Moniepoint MFB', code: '999993', aliases: ['moniepoint'], paycrestInstitutionCode: 'MONINGPC' },
  { name: 'Safe Haven MFB', code: '999994', aliases: ['safe haven mfb'], paycrestInstitutionCode: 'SAHVNGPC' },
  { name: 'Zenith Bank', code: '057', aliases: ['zenith'], paycrestInstitutionCode: 'ZENITHNGLA' },
  { name: 'GTBank', code: '058', aliases: ['gtbank'], paycrestInstitutionCode: 'GTBNGLA' },
  { name: 'First Bank of Nigeria', code: '011', aliases: ['first bank'], paycrestInstitutionCode: 'FBNNGLA' },
  { name: 'UBA', code: '032', aliases: ['uba'], paycrestInstitutionCode: 'UBANGPC' },
  { name: 'FCMB', code: '214', aliases: ['fcmb'], paycrestInstitutionCode: 'FCMBNGPC' },
];

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
    supportedAssets: ['USDC', 'USDT'],
    network: 'BNB Smart Chain',
    assets: {
      USDC: 'ff479231-0dbb-4760-b695-e219a50934af',
      USDT: '03a11a51-1422-4ac0-abc0-b2fed75e9fcb',
    }
  }
};

const chainMapping = {
  'base': 'Base',
  'polygon': 'Polygon',
  'bnb smart chain': 'BNB Smart Chain',
  'bnb smartchain': 'BNB Smart Chain',
  'bnb chain': 'BNB Smart Chain',
  'bnb': 'BNB Smart Chain',
};

/*****************************************
 *       Helper Functions
 *****************************************/
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

function calculatePayoutWithFee(amount, rate, feePercent = 0.5) {
  const fee = (amount * rate) * (feePercent / 100);
  return parseFloat(((amount * rate) - fee).toFixed(2));
}

function generateReferenceId() {
  return 'REF-' + Math.random().toString(36).substr(2, 9).toUpperCase();
}

/**
 * Verify bank account via Paystack
 */
async function verifyBankAccount(accountNumber, bankCode) {
  try {
    const response = await axios.get('https://api.paystack.co/bank/resolve', {
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
 * Create Paycrest order
 */
async function createPaycrestOrder(userId, amount, token, network, recipientDetails, userSendAddress) {
  try {
    const paycrestMapping = mapToPaycrest(token, network);
    if (!paycrestMapping) {
      throw new Error('No Paycrest mapping for the selected asset/chain.');
    }
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
      memo: 'Payment from DirectPay',
      providerId: ''
    };

    const rate = exchangeRates[token];
    if (!rate) {
      throw new Error(`Exchange rate for ${token} not available.`);
    }

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

    if (orderResp.data.status !== 'success') {
      throw new Error(`Paycrest order creation failed: ${orderResp.data.message}`);
    }
    return orderResp.data.data;
  } catch (err) {
    logger.error(`Error creating Paycrest order: ${err.response ? err.response.data.message : err.message}`);
    throw new Error('Failed to create Paycrest order.');
  }
}

/**
 * Withdraw from Blockradar
 */
async function withdrawFromBlockradar(chain, assetId, address, amount, reference, metadata) {
  try {
    const chainKey = chainMapping[chain.toLowerCase()];
    if (!chainKey) {
      throw new Error(`Unsupported or unknown chain: ${chain}`);
    }
    const chainData = chains[chainKey];
    if (!chainData) {
      throw new Error(`Chain data not found for: ${chainKey}`);
    }
    const resp = await axios.post(
      `https://api.blockradar.co/v1/wallets/${chainData.id}/withdraw`,
      {
        address,
        amount: String(amount),
        assetId,
        reference,
        metadata
      },
      {
        headers: {
          'x-api-key': chainData.key,
          'Content-Type': 'application/json'
        }
      }
    );
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
 * Firestore user state
 */
async function getUserState(userId) {
  try {
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      await db.collection('users').doc(userId).set({
        firstName: '',
        wallets: [],
        walletAddresses: [],
        hasReceivedDeposit: false,
        awaitingBroadcastMessage: false,
        usePidgin: false,
      });
      return {
        firstName: '',
        wallets: [],
        walletAddresses: [],
        hasReceivedDeposit: false,
        awaitingBroadcastMessage: false,
        usePidgin: false,
      };
    } else {
      const data = userDoc.data();
      return {
        firstName: data.firstName || '',
        wallets: data.wallets || [],
        walletAddresses: data.walletAddresses || [],
        hasReceivedDeposit: data.hasReceivedDeposit || false,
        awaitingBroadcastMessage: data.awaitingBroadcastMessage || false,
        usePidgin: data.usePidgin || false,
      };
    }
  } catch (error) {
    logger.error(`Error getting user state for ${userId}: ${error.message}`);
    throw error;
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

/**
 * Generate new wallet (Blockradar)
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

function isAdmin(userId) {
  return ADMIN_IDS.split(',').map(id => id.trim()).includes(userId.toString());
}

/*****************************************
 *         Scenes (Bank Linking, etc.)
 *****************************************/
const bankLinkingScene = new Scenes.WizardScene(
  'bank_linking_scene',
  async (ctx) => {
    // Step 1: Ask bank name
    const userId = ctx.from.id.toString();
    const walletIndex = ctx.session.walletIndex;
    if (walletIndex === undefined || walletIndex === null) {
      await ctx.replyWithMarkdown('⚠️ An error occurred. Please generate a wallet first.');
      return ctx.scene.leave();
    }
    ctx.session.bankData = {};
    ctx.session.bankData.step = 1;
    const userState = await getUserState(userId);

    // Using your provided "Bank Linking Prompt (Step 1 - Bank Name)"
    const message = userState.usePidgin
      ? '🏦 Abeg tell us your bank name (e.g., Access Bank):'
      : '🏦 Please enter your bank name (e.g., Access Bank):';

    await ctx.replyWithMarkdown(message);
    return ctx.wizard.next();
  },
  async (ctx) => {
    // Step 2: Ask account number
    const userId = ctx.from.id.toString();
    const input = ctx.message.text.trim().toLowerCase();
    logger.info(`User ${userId} bank name input: ${input}`);

    const bank = bankList.find(b => b.aliases.includes(input));
    if (!bank) {
      const userState = await getUserState(userId);
      const errorMsg = userState.usePidgin
        ? `❌ Bank name no correct. Try again from these:\n${bankList.map(b => `• ${b.name}`).join('\n')}`
        : `❌ Invalid bank name. Please pick from our list:\n${bankList.map(b => `• ${b.name}`).join('\n')}`;
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }

    ctx.session.bankData.bankName = bank.name;
    ctx.session.bankData.bankCode = bank.code;
    ctx.session.bankData.step = 2;

    const userState = await getUserState(userId);
    // Using your provided "Bank Linking Prompt (Step 2 - Account Number)"
    const message = userState.usePidgin
      ? '🔢 Abeg put your 10-digit bank account number:'
      : '🔢 Please enter your 10-digit bank account number:';

    await ctx.replyWithMarkdown(message);
    return ctx.wizard.next();
  },
  async (ctx) => {
    // Step 3: Verify account number
    const userId = ctx.from.id.toString();
    const input = ctx.message.text.trim();
    logger.info(`User ${userId} account number input: ${input}`);

    if (!/^\d{10}$/.test(input)) {
      const userState = await getUserState(userId);
      const errorMsg = userState.usePidgin
        ? '❌ Invalid account number. Must be 10 digits.'
        : '❌ Invalid account number. Please enter a valid 10-digit number.';
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }

    ctx.session.bankData.accountNumber = input;
    ctx.session.bankData.step = 3;

    const userState = await getUserState(userId);
    // Could say "Verifying bank details" etc.
    const verifyingMsg = userState.usePidgin
      ? '🔄 Checking your bank details... hold on small.'
      : '🔄 Verifying your bank details...';

    await ctx.replyWithMarkdown(verifyingMsg);

    try {
      const verifyResult = await verifyBankAccount(input, ctx.session.bankData.bankCode);
      if (!verifyResult || !verifyResult.data?.account_name) {
        throw new Error('Failed to get account name');
      }
      ctx.session.bankData.accountName = verifyResult.data.account_name;

      // Using "Bank Linking Verification" message
      const confirmMsg = userState.usePidgin
        ? `🏦 *Bank Account Check*\n\nAbeg confirm your bank details:\n- *Bank Name:* ${ctx.session.bankData.bankName}\n- *Account Number:* ${input}\n- *Account Holder:* ${verifyResult.data.account_name}\n\nThis one correct so?`
        : `🏦 *Bank Account Verification*\n\nPlease confirm your bank details:\n- *Bank Name:* ${ctx.session.bankData.bankName}\n- *Account Number:* ${input}\n- *Account Holder:* ${verifyResult.data.account_name}\n\nIs this information correct?`;

      await ctx.replyWithMarkdown(
        confirmMsg,
        Markup.inlineKeyboard([
          [Markup.button.callback('✅ Yes, Confirm', 'confirm_bank_yes')],
          [Markup.button.callback('❌ No, Edit Details', 'confirm_bank_no')],
          [Markup.button.callback('❌ Cancel Linking', 'cancel_bank_linking')]
        ])
      );
      return ctx.wizard.next();
    } catch (error) {
      logger.error(`Error verifying bank details: ${error.message}`);
      await ctx.replyWithMarkdown('⚠️ Error verifying account. Please try again.');
      return ctx.scene.leave();
    }
  },
  async (ctx) => {
    // Final step, handled by inline buttons
  }
);

bankLinkingScene.action('confirm_bank_yes', async (ctx) => {
  try {
    const userId = ctx.from.id.toString();
    const userState = await getUserState(userId);
    const bankData = ctx.session.bankData;
    const walletIndex = ctx.session.walletIndex;
    const wallet = userState.wallets[walletIndex];
    if (!wallet) {
      await ctx.replyWithMarkdown('⚠️ No wallet found. Please generate a wallet first.');
      await ctx.answerCbQuery();
      return ctx.scene.leave();
    }

    // Link the bank
    wallet.bank = {
      bankName: bankData.bankName,
      bankCode: bankData.bankCode,
      accountNumber: bankData.accountNumber,
      accountName: bankData.accountName,
    };
    await updateUserState(userId, { wallets: userState.wallets });

    // Using "Bank Linking Success" message
    const successMsg = userState.usePidgin
      ? `👏 *Bank Account Don Join Finish!*\n\nWelcome to DirectPay! See your wallet info:\n*Wallet Address:* \`${wallet.address}\`\n*Supported Networks:* Base, BNB Smart Chain, Polygon (Matic)\n*Supported Assets:* USDC, USDT\n*Bank Name:* ${bankData.bankName}\n*Account Number:* ${bankData.accountNumber}\n*Account Holder:* ${bankData.accountName}\n\nNa only USDC and USDT we dey take. No go send shiba inu come this address o, cause even verydarkman no go carry your case. Scan the QR code below to copy your wallet address!`
      : `👏 *Bank Account Linked Successfully!*\n\nWelcome to DirectPay! Here are your wallet details:\n*Wallet Address:* \`${wallet.address}\`\n*Supported Networks:* Base, BNB Smart Chain, Polygon (Matic)\n*Supported Assets:* USDC, USDT\n*Bank Name:* ${bankData.bankName}\n*Account Number:* ${bankData.accountNumber}\n*Account Holder:* ${bankData.accountName}\n\nOnly USDC and USDT are supported. Contact support if you deposit other tokens. Scan the QR code below to copy your wallet address!`;

    // Generate & send QR code
    try {
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=1000x1000&data=${encodeURIComponent(wallet.address)}`;
      const qrResp = await axios.get(qrUrl, { responseType: 'arraybuffer' });
      const qrBuffer = Buffer.from(qrResp.data);
      const outputImg = path.join(__dirname, `temp/wallet_with_qr_${userId}.png`);
      await sharp(WALLET_GENERATED_IMAGE)
        .composite([{ input: qrBuffer, top: 1920, left: 1600 }])
        .toFile(outputImg);

      await bot.telegram.sendPhoto(userId, { source: outputImg }, {
        caption: successMsg,
        parse_mode: 'Markdown'
      });
      fs.unlinkSync(outputImg);
    } catch (qrErr) {
      logger.error(`Failed to generate QR for user ${userId}: ${qrErr.message}`);
      // fallback
      await ctx.replyWithMarkdown(successMsg);
    }

    // If user has no name set, ask if the bank is theirs
    if (!userState.firstName) {
      const question = userState.usePidgin
        ? `📋 One small question: This bank account (${bankData.accountName}), na your own or another person get am?\n\n[✅ Na my own!] [❌ Na another person]`
        : `📋 One quick question: Is this bank account (${bankData.accountName}) yours?\n\n[✅ It’s mine!] [❌ It’s a third party’s]`;
      await ctx.replyWithMarkdown(
        question,
        Markup.inlineKeyboard([
          [Markup.button.callback(userState.usePidgin ? '✅ Na my own!' : '✅ It’s mine!', 'bank_is_mine')],
          [Markup.button.callback(userState.usePidgin ? '❌ Na another person' : '❌ It’s a third party’s', 'bank_is_third_party')]
        ])
      );
    } else {
      // Show main menu
      const updatedState = await getUserState(userId);
      await ctx.replyWithMarkdown(
        updatedState.usePidgin
          ? `All done! See your menu, ${updatedState.firstName}.`
          : `All done! Here’s your menu, ${updatedState.firstName}.`,
        getMainMenu(updatedState)
      );
      if (isAdmin(userId)) {
        await ctx.reply(
          updatedState.usePidgin
            ? `Admin options, ${updatedState.firstName}:`
            : `Admin options, ${updatedState.firstName}:`,
          Markup.inlineKeyboard([[Markup.button.callback('🔧 Admin Panel', 'open_admin_panel')]])
        );
      }
    }

    // Admin log
    await bot.telegram.sendMessage(
      PERSONAL_CHAT_ID,
      `User ${userId} linked bank:\n- Bank: ${wallet.bank.bankName}\n- Acct: ${wallet.bank.accountNumber}\n- Name: ${wallet.bank.accountName}`,
      { parse_mode: 'Markdown' }
    );
    await ctx.answerCbQuery();
    ctx.scene.leave();
  } catch (error) {
    logger.error(`Error in confirm_bank_yes: ${error.message}`);
    await ctx.answerCbQuery();
    ctx.scene.leave();
  }
});

bankLinkingScene.action('confirm_bank_no', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.scene.reenter();
});

bankLinkingScene.action('cancel_bank_linking', async (ctx) => {
  await ctx.answerCbQuery('Bank linking cancelled.', { show_alert: true });
  ctx.scene.leave();
});

bankLinkingScene.action('bank_is_mine', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    const userState = await getUserState(userId);
    const { accountName } = ctx.session.bankData;
    const guessed = accountName.split(' ')[0] || 'Friend';
    await updateUserState(userId, { firstName: guessed });
    await ctx.replyWithMarkdown(
      userState.usePidgin
        ? `Correct! We go dey call you ${guessed} from now on.`
        : `Great! We’ll call you ${guessed} from now on.`,
      getMainMenu(await getUserState(userId))
    );
    ctx.scene.leave();
  } catch (error) {
    logger.error(`Error in bank_is_mine: ${error.message}`);
    ctx.answerCbQuery();
    ctx.scene.leave();
  }
});

bankLinkingScene.action('bank_is_third_party', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session.awaitingName = true;
  const userState = await getUserState(ctx.from.id.toString());
  const prompt = userState.usePidgin
    ? 'Okay o! Wetin be your name then? Abeg give us your "FirstName LastName"'
    : 'Alright! Please provide your first and last name, e.g., "Chioma Eze"';
  await ctx.replyWithMarkdown(prompt);
});

bankLinkingScene.on('text', async (ctx) => {
  if (ctx.session.awaitingName) {
    const userId = ctx.from.id.toString();
    const input = ctx.message.text.trim();
    const parts = input.split(' ');
    if (parts.length < 2) {
      const userState = await getUserState(userId);
      const msg = userState.usePidgin
        ? '❌ Provide full name, e.g., "Chioma Eze"'
        : '❌ Please provide "FirstName LastName", e.g., "Chioma Eze"';
      await ctx.replyWithMarkdown(msg);
      return;
    }
    const firstName = parts[0];
    await updateUserState(userId, { firstName });
    await ctx.replyWithMarkdown(
      `Excellent! We’ll call you ${firstName} from now on.`,
      getMainMenu(await getUserState(userId))
    );
    ctx.scene.leave();
    delete ctx.session.awaitingName;
    delete ctx.session.bankData;
    delete ctx.session.walletIndex;
  }
});

// Rename Wallet Scene
const renameWalletScene = new Scenes.WizardScene(
  'rename_wallet_scene',
  async (ctx) => {
    const userState = await getUserState(ctx.from.id.toString());
    await ctx.replyWithMarkdown(
      userState.usePidgin
        ? '📋 Enter new wallet name:'
        : 'Please enter a new name for your wallet:'
    );
    return ctx.wizard.next();
  },
  async (ctx) => {
    const newName = ctx.message.text.trim();
    if (!newName) {
      return ctx.replyWithMarkdown('❌ Name cannot be empty. Try again:');
    }
    const walletIndex = ctx.session.renameWalletIndex;
    const userId = ctx.from.id.toString();
    let userState = await getUserState(userId);

    if (userState.wallets[walletIndex]) {
      userState.wallets[walletIndex].label = newName;
      await updateUserState(userId, { wallets: userState.wallets });
      await ctx.replyWithMarkdown(`✅ Wallet renamed to *${newName}* successfully.`);
    } else {
      await ctx.replyWithMarkdown('⚠️ Wallet not found.');
    }
    delete ctx.session.renameWalletIndex;
    ctx.scene.leave();
  }
);

const stage = new Scenes.Stage();
stage.register(bankLinkingScene, renameWalletScene);
bot.use(session());
bot.use(stage.middleware());

/*****************************************
 *     Exchange Rate Management
 *     + CoinGecko partial comparison
 *****************************************/
const SUPPORTED_ASSETS = ['USDC', 'USDT'];
let exchangeRates = { USDC: 0, USDT: 0 };
let coinGeckoRates = { USDC: 0, USDT: 0 }; // We'll store them too

async function fetchCoinGeckoRates() {
  try {
    // NOTE: This is a placeholder. Actual CoinGecko endpoints for stablecoins might differ.
    // You’d fetch something like:
    // e.g. GET https://api.coingecko.com/api/v3/simple/price?ids=tether,usd-coin&vs_currencies=ngn
    // Then parse the JSON to get the rates
    // For demonstration, let’s just pretend we get some random float.
    coinGeckoRates.USDC = 700 + Math.random() * 50; // Fake data
    coinGeckoRates.USDT = 710 + Math.random() * 50; // Fake data
    logger.info('CoinGecko rates updated (mock).');
  } catch (err) {
    logger.error(`Error fetching CoinGecko rates: ${err.message}`);
  }
}

async function fetchExchangeRate(asset) {
  // Paycrest rate
  try {
    const response = await axios.get(`${PAYCREST_RATE_API_URL}`, {
      headers: {
        Authorization: `Bearer ${PAYCREST_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    if (response.data.status === 'success' && response.data.data) {
      const rate = parseFloat(response.data.data);
      if (isNaN(rate)) {
        throw new Error(`Invalid rate for ${asset}: ${response.data.data}`);
      }
      return rate;
    } else {
      throw new Error(`Failed to fetch rate for ${asset}: ${response.data.message || 'Unknown error'}`);
    }
  } catch (error) {
    logger.error(`Error fetching exchange rate for ${asset}: ${error.message}`);
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
    logger.info('Exchange rates updated from Paycrest.');
  } catch (error) {
    logger.error(`Error fetching exchange rates from Paycrest: ${error.message}`);
  }
}
fetchExchangeRates();
fetchCoinGeckoRates();
setInterval(fetchExchangeRates, 300000);  // Refresh every 5 minutes
setInterval(fetchCoinGeckoRates, 360000); // Refresh CoinGecko every 6 minutes

/*****************************************
 *         Main Menu & /start
 *****************************************/
function getMainMenu(userState) {
  const hasWallets = userState.wallets && userState.wallets.length > 0;
  return {
    reply_markup: Markup.keyboard([
      [ hasWallets ? '💼 View Wallet' : '💼 Generate Wallet', '⚙️ Settings' ],
      ['💰 Transactions', 'ℹ️ Support', '📘 Learn About Base'],
      ['📈 View Current Rates']
    ]).resize()
  };
}

bot.start(async (ctx) => {
  try {
    await greetUser(ctx);
  } catch (err) {
    logger.error(`Error in /start: ${err.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again.');
  }
});

async function greetUser(ctx) {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  // 1. Greeting (/start Command)
  if (!userState.firstName && ctx.from.first_name) {
    await updateUserState(userId, { firstName: ctx.from.first_name });
    userState.firstName = ctx.from.first_name;
  }

  const greetingEnglish = `👋 Welcome, ${userState.firstName || 'valued user'}!\n\nThank you for choosing **DirectPay**. We convert your cryptocurrency to cash quickly and securely. Let’s get started:`;
  const greetingPidgin = `👋 Welcome, ${userState.firstName || 'my friend'}!\n\nThank you say you pick **DirectPay**. We dey change crypto to cash fast and safe. No Fugazzi. Make we start:`;

  const mainMenu = getMainMenu(userState);
  if (userState.usePidgin) {
    await ctx.replyWithMarkdown(greetingPidgin, mainMenu);
    // Suggest "location" part if you want, or skip
  } else {
    await ctx.replyWithMarkdown(greetingEnglish, mainMenu);
    // Possibly mention "We see you might be in Nigeria..." etc.
    await ctx.reply(
      'We see you might be in Nigeria. Want to switch to Pidgin for a better vibe? Just type "Pidgin" anytime!'
    );
  }

  if (isAdmin(userId)) {
    await ctx.reply(
      userState.usePidgin
        ? `Admin options, ${userState.firstName || 'boss'}:`
        : `Admin options, ${userState.firstName || 'admin'}:`,
      Markup.inlineKeyboard([[Markup.button.callback('🔧 Admin Panel', 'open_admin_panel')]])
    );
  }
}

bot.hears('Pidgin', async (ctx) => {
  const userId = ctx.from.id.toString();
  await updateUserState(userId, { usePidgin: true });
  const userState = await getUserState(userId);

  await ctx.replyWithMarkdown(
    `Ehen! ${userState.firstName || 'friend'}, we don switch to Pidgin for you o!`,
    getMainMenu(userState)
  );

  if (isAdmin(userId)) {
    await ctx.reply(
      `Admin options, ${userState.firstName || 'big boss'}:`,
      Markup.inlineKeyboard([[Markup.button.callback('🔧 Admin Panel', 'open_admin_panel')]])
    );
  }
});

/*****************************************
 *   Generate Wallet (Immediate bank-link)
 *****************************************/
bot.hears('💼 Generate Wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    if (userState.wallets.length >= MAX_WALLETS) {
      // 17. Max Wallets Reached
      const msg = userState.usePidgin
        ? `⚠️ You don reach max wallets o (${MAX_WALLETS})! Arrange the ones you get first.`
        : `⚠️ You have reached the maximum number of wallets (${MAX_WALLETS}). Please manage your existing wallets first.`;
      return ctx.replyWithMarkdown(msg);
    }

    // 2. Wallet Generation Success
    const chain = 'Base'; // default
    const generating = userState.usePidgin
      ? '🔄 Generating wallet... hold on small.'
      : '🔄 Generating wallet... please wait.';
    const notice = await ctx.replyWithMarkdown(generating);

    const walletAddress = await generateWallet(chain);

    // Add to user’s state
    userState.wallets.push({
      address: walletAddress,
      chain,
      supportedAssets: ['USDC', 'USDT'],
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

    await ctx.deleteMessage(notice.message_id);

    const successEnglish = `✅ *Wallet Generated Successfully!*\n\n*Supported Networks:* Base, BNB Smart Chain, Polygon (Matic)\n*Supported Assets:* USDC, USDT\n\nPlease link a bank account to proceed. Your wallet address will be shown once your bank details are confirmed..`;
    const successPidgin = `✅ *Wallet Don Ready!*\n\n*Supported Networks:* Base, BNB Smart Chain, Polygon (Matic)\n*Supported Assets:* USDC, USDT\n\nAbeg link your bank account make we move forward. We go show you the wallet address when you put your bank details.`;

    if (userState.usePidgin) {
      await ctx.replyWithMarkdown(successPidgin);
    } else {
      await ctx.replyWithMarkdown(successEnglish);
    }

    // Immediately link bank
    ctx.session.walletIndex = userState.wallets.length - 1;
    await ctx.scene.enter('bank_linking_scene');
  } catch (error) {
    logger.error(`Error generating wallet: ${error.message}`);
    const userState = await getUserState(ctx.from.id.toString());
    const errMsg = userState.usePidgin
      ? '⚠️ E no work o! Try again later.'
      : '⚠️ An error occurred. Please try again later.';
    await ctx.replyWithMarkdown(errMsg);
  }
});

/*****************************************
 *          View Wallet
 *****************************************/
bot.hears('💼 View Wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  if (!userState.wallets || userState.wallets.length === 0) {
    // 16. No Wallet Error
    const msg = userState.usePidgin
      ? '❌ You no get wallet o! Click "💼 Generate Wallet" to make one.'
      : '❌ You have no wallets. Click "💼 Generate Wallet" to create one.';
    return ctx.replyWithMarkdown(msg);
  }

  let message = userState.usePidgin
    ? '*Your Wallets:*\n'
    : '*Your Wallets:*\n';

  const inlineKeyboard = [];
  userState.wallets.forEach((w, i) => {
    message += `\n• Wallet #${i + 1}\n`
      + `   - Address: \`${w.address}\`\n`
      + `   - Network: ${w.chain}\n`
      + `   - Deposits: ${w.totalDeposits || 0}\n`
      + `   - Payouts: ₦${w.totalPayouts || 0}\n`
      + `   - Bank: ${w.bank ? 'Yes' : 'No'}\n`;
    inlineKeyboard.push([
      Markup.button.callback(`Manage Wallet #${i + 1}`, `manage_wallet_${i}`)
    ]);
  });
  await ctx.replyWithMarkdown(message, Markup.inlineKeyboard(inlineKeyboard));
});

/*****************************************
 *      Manage Wallet (No Export Btn)
 *****************************************/
bot.action(/manage_wallet_(\d+)/, async (ctx) => {
  const index = parseInt(ctx.match[1], 10);
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  const wallet = userState.wallets[index];
  if (!wallet) {
    await ctx.answerCbQuery('Wallet not found.', { show_alert: true });
    return;
  }

  let info = `*Wallet #${index + 1}*\n`
    + `- Address: \`${wallet.address}\`\n`
    + `- Network: ${wallet.chain}\n`
    + `- Deposits: ${wallet.totalDeposits || 0}\n`
    + `- Payouts: ₦${wallet.totalPayouts || 0}\n`
    + `- Bank Linked: ${wallet.bank ? 'Yes' : 'No'}\n`;

  await ctx.editMessageText(info, {
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback('✏️ Rename', `rename_wallet_${index}`)],
      [Markup.button.callback('🏦 Edit Bank', `edit_bank_${index}`)],
      [Markup.button.callback('🗑️ Delete', `delete_wallet_${index}`)],
      [Markup.button.callback('🔙 Back', 'back_to_wallet_list')],
    ])
  });
  await ctx.answerCbQuery();
});

bot.action(/rename_wallet_(\d+)/, async (ctx) => {
  const idx = parseInt(ctx.match[1], 10);
  ctx.session.renameWalletIndex = idx;
  await ctx.answerCbQuery();
  ctx.scene.enter('rename_wallet_scene');
});

bot.action(/edit_bank_(\d+)/, async (ctx) => {
  const idx = parseInt(ctx.match[1], 10);
  ctx.session.walletIndex = idx;
  await ctx.answerCbQuery();
  ctx.scene.enter('bank_linking_scene');
});

bot.action(/delete_wallet_(\d+)/, async (ctx) => {
  const idx = parseInt(ctx.match[1], 10);
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  if (idx < 0 || idx >= userState.wallets.length) {
    await ctx.answerCbQuery('Wallet not found.', { show_alert: true });
    return;
  }

  userState.wallets.splice(idx, 1);
  userState.walletAddresses = userState.wallets.map(w => w.address);
  await updateUserState(userId, {
    wallets: userState.wallets,
    walletAddresses: userState.walletAddresses,
  });

  await ctx.answerCbQuery('Deleted wallet.', { show_alert: true });
  await ctx.editMessageText('Wallet deleted.', { parse_mode: 'Markdown' });

  const updatedState = await getUserState(userId);
  await ctx.replyWithMarkdown(
    'Here’s your updated menu:',
    getMainMenu(updatedState)
  );
});

bot.action('back_to_wallet_list', async (ctx) => {
  await ctx.answerCbQuery();
  bot.hears('💼 View Wallet')(ctx);
});

/*****************************************
 *        Transactions
 *****************************************/
bot.hears(/💰\s*Transactions/i, async (ctx) => {
  const userId = ctx.from.id.toString();
  const pageSize = 5;
  let page = ctx.session.transactionsPage || 1;
  let filter = ctx.session.transactionsFilter || 'all';
  let asset = ctx.session.transactionsAsset || 'All';
  const filterOptions = ['all', 'Completed', 'Pending', 'Failed', 'Refunded'];
  const assetOptions = ['USDC', 'USDT', 'All'];

  const userState = await getUserState(userId);

  try {
    let query = db.collection('transactions')
      .where('userId', '==', userId)
      .orderBy('timestamp', 'desc');

    if (filter !== 'all') {
      query = query.where('status', '==', filter);
    }
    if (asset !== 'All') {
      query = query.where('asset', '==', asset);
    }

    const snapshot = await query.limit(pageSize * page).get();
    const totalCount = snapshot.size;
    const transactions = snapshot.docs.slice(-pageSize);

    if (totalCount === 0) {
      return ctx.replyWithMarkdown(
        userState.usePidgin
          ? 'No transactions found.'
          : 'No transactions found.'
      );
    }

    // 13. Transaction History 
    let message = userState.usePidgin
      ? `💰 *Transaction History (Page ${page})*\n`
      : `💰 *Transaction History (Page ${page})*\n`;

    transactions.forEach((doc, idx) => {
      const tx = doc.data();
      message += `\n🌟 *Transaction #${idx + 1}*\n`
        + `🔹 *Reference ID:* \`${tx.referenceId}\`\n`
        + `🔹 *Status:* ${tx.status}\n`
        + `🔹 *Deposit Amount:* ${tx.amount} ${tx.asset}\n`
        + `🔹 *Network:* ${tx.chain}\n`
        + `🔹 *Exchange Rate:* ₦${(tx.rate || 0)}/${
           tx.asset
        }\n`
        + `🔹 *Payout Amount:* ₦${tx.payout || 0}\n`
        + `🔹 *Bank:* ${tx.bankDetails ? tx.bankDetails.bankName : 'N/A'}\n`
        + `🔹 *Account:* ${
            tx.bankDetails && tx.bankDetails.accountNumber
            ? '****' + tx.bankDetails.accountNumber.slice(-4)
            : 'N/A'
          }\n`
        + `🔹 *Holder:* ${tx.bankDetails ? tx.bankDetails.accountName : 'N/A'}\n`
        + `🔹 *Timestamp:* ${new Date(tx.timestamp).toLocaleString()}\n`
        + `🔹 *Tx Hash:* \`${tx.transactionHash || 'N/A'}\`\n`;
    });

    const totalPages = Math.ceil(totalCount / pageSize);
    const navigationButtons = [
      Markup.button.callback('⬅️ Prev', `transactions_page_${Math.max(1, page - 1)}_${filter}_${asset}`),
      Markup.button.callback('Next ➡️', `transactions_page_${Math.min(totalPages, page + 1)}_${filter}_${asset}`),
      Markup.button.callback('🔄 Refresh', `transactions_page_${page}_${filter}_${asset}`)
    ];
    const filterButtons = filterOptions.map(st => Markup.button.callback(st, `transactions_filter_${st}_${asset}`));
    const assetButtons = assetOptions.map(a => Markup.button.callback(a, `transactions_asset_${filter}_${a}`));

    await ctx.replyWithMarkdown(message, Markup.inlineKeyboard([
      navigationButtons,
      filterButtons,
      assetButtons
    ]));

    ctx.session.transactionsPage = page;
    ctx.session.transactionsFilter = filter;
    ctx.session.transactionsAsset = asset;
  } catch (err) {
    logger.error(`Error fetching transactions: ${err.message}`);
    const msg = userState.usePidgin
      ? '⚠️ E no work o! Try again later.'
      : '⚠️ Unable to fetch transactions. Please try again later.';
    await ctx.replyWithMarkdown(msg);
  }
});

bot.action(/transactions_page_(\d+)_([^_]+)_([^_]+)/, async (ctx) => {
  ctx.session.transactionsPage = parseInt(ctx.match[1], 10);
  ctx.session.transactionsFilter = ctx.match[2];
  ctx.session.transactionsAsset = ctx.match[3];
  await ctx.answerCbQuery();
  bot.hears('💰 Transactions')(ctx);
});

bot.action(/transactions_filter_([^_]+)_([^_]+)/, async (ctx) => {
  ctx.session.transactionsFilter = ctx.match[1];
  ctx.session.transactionsAsset = ctx.match[2];
  ctx.session.transactionsPage = 1;
  await ctx.answerCbQuery();
  bot.hears('💰 Transactions')(ctx);
});

bot.action(/transactions_asset_([^_]+)_([^_]+)/, async (ctx) => {
  ctx.session.transactionsFilter = ctx.match[1];
  ctx.session.transactionsAsset = ctx.match[2];
  ctx.session.transactionsPage = 1;
  await ctx.answerCbQuery();
  bot.hears('💰 Transactions')(ctx);
});

/*****************************************
 *        View Current Rates
 *****************************************/
bot.hears('📈 View Current Rates', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const now = new Date().toLocaleTimeString('en-US', { timeZone: 'Africa/Lagos', hour12: false });
  const date = new Date().toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' });

  // Let’s compare Paycrest (directPay) vs CoinGecko
  const usdcPaycrest = exchangeRates.USDC.toFixed(2);
  const usdtPaycrest = exchangeRates.USDT.toFixed(2);

  const usdcGecko = coinGeckoRates.USDC.toFixed(2);
  const usdtGecko = coinGeckoRates.USDT.toFixed(2);

  // We always prefer the directPay rate
  let ratesMessage;
  if (userState.usePidgin) {
    ratesMessage = `📈 *Current Exchange Rates (${now} WAT, ${date})*\n\n`
      + `*DirectPay Rates*\n  • USDC: ₦${usdcPaycrest}\n  • USDT: ₦${usdtPaycrest}\n\n`
        + `*Market Rates*\n  • USDC: ₦${usdcGecko}\n  • USDT: ₦${usdtGecko}\n\n`
      + `No mind CoinGecko own o! We dey give you beta rate wey sure pass. Others fit talk say dem cheap, but DirectPay still be boss!\n`;
  } else {
    ratesMessage = `📈 *Current Exchange Rates (${now} WAT, ${date})*\n\n`
      + `*DirectPay Rates*\n  • USDC: ₦${usdcPaycrest}\n  • USDT: ₦${usdtPaycrest}\n\n`
      + `*Market Rates*\n  • USDC: ₦${usdcGecko}\n  • USDT: ₦${usdtGecko}\n\n`
      + `Omo, you for don lose money if you go sell USDC elsewhere! Stick with DirectPay, abeg!`;
  }

  await ctx.replyWithMarkdown(ratesMessage, getMainMenu(userState));
});

/*****************************************
 *        Settings
 *****************************************/
bot.hears('⚙️ Settings', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  const text = userState.usePidgin
    ? '⚙️ *Settings Menu*'
    : '⚙️ *Settings Menu*';
  const inline = Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Generate New Wallet', 'settings_generate_wallet')],
    [Markup.button.callback('✏️ Edit Linked Bank Details', 'settings_edit_bank')],
    [Markup.button.callback('💬 Support', 'settings_support')],
    [Markup.button.callback('🔙 Back to Main Menu', 'settings_back_main')]
  ]);
  await ctx.replyWithMarkdown(text, inline);
});

bot.action('settings_generate_wallet', async (ctx) => {
  await ctx.answerCbQuery();
  bot.hears('💼 Generate Wallet')(ctx);
});

bot.action('settings_edit_bank', async (ctx) => {
  const userId = ctx.from.id.toString();
  await ctx.answerCbQuery();
  const userState = await getUserState(userId);

  if (userState.wallets.length === 0) {
    const msg = userState.usePidgin
      ? '❌ You no get wallet. Generate one first.'
      : '❌ You have no wallets. Generate one first.';
    return ctx.replyWithMarkdown(msg);
  }
  if (userState.wallets.length === 1) {
    ctx.session.walletIndex = 0;
    ctx.scene.enter('bank_linking_scene');
  } else {
    const inlineKeyboard = userState.wallets.map((w, i) => [
      Markup.button.callback(`Wallet #${i + 1} (${w.chain})`, `select_wallet_edit_bank_${i}`)
    ]);
    await ctx.reply(
      userState.usePidgin
        ? 'Pick the wallet for which you want to edit bank details:'
        : 'Please select the wallet for editing bank details:',
      Markup.inlineKeyboard(inlineKeyboard)
    );
  }
});

bot.action(/select_wallet_edit_bank_(\d+)/, async (ctx) => {
  const idx = parseInt(ctx.match[1], 10);
  ctx.session.walletIndex = idx;
  await ctx.answerCbQuery();
  ctx.scene.enter('bank_linking_scene');
});

bot.action('settings_support', async (ctx) => {
  await ctx.answerCbQuery();
  const userState = await getUserState(ctx.from.id.toString());
  const prompt = userState.usePidgin
    ? '🛠️ *Support Section*\n\nPick one option:'
    : '🛠️ *Support Section*\n\nSelect an option:';
  await ctx.replyWithMarkdown(prompt, Markup.inlineKeyboard([
    [Markup.button.callback('❓ How It Works', 'support_how_it_works')],
    [Markup.button.callback('⚠️ Transaction Not Received', 'support_not_received')],
    [Markup.button.callback('💬 Contact Support', 'support_contact')],
  ]));
});

bot.action('settings_back_main', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);

  await ctx.replyWithMarkdown(
    userState.usePidgin
      ? `Back to main menu, ${userState.firstName || ''}`
      : `Back to main menu, ${userState.firstName || ''}`,
    getMainMenu(userState)
  );
});

/*****************************************
 *         Admin Panel (Example)
 *****************************************/
bot.action('open_admin_panel', async (ctx) => {
  const userId = ctx.from.id.toString();
  const userState = await getUserState(userId);
  if (!isAdmin(userId)) {
    const msg = userState.usePidgin
      ? '⚠️ You no be admin.'
      : '⚠️ You are not an admin.';
    await ctx.replyWithMarkdown(msg);
    return ctx.answerCbQuery();
  }

  const panelText = userState.usePidgin
    ? `👨‍💼 *Admin Panel*\n\nPick one option, ${userState.firstName || 'boss'}:`
    : `👨‍💼 *Admin Panel*\n\nSelect an option, ${userState.firstName || 'admin'}:`;

  await ctx.editMessageText(panelText, {
    parse_mode: 'Markdown',
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback('📋 View Recent Transactions', 'admin_view_transactions')],
      [Markup.button.callback('📢 Broadcast Message', 'admin_broadcast_message')],
      [Markup.button.callback('🔙 Back to Main Menu', 'admin_back_to_main')],
    ])
  });
  await ctx.answerCbQuery();
});

/*****************************************
 *         Paycrest Webhook
 *****************************************/
app.post(WEBHOOK_PAYCREST_PATH, bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-paycrest-signature'];
  const rawBody = req.body;

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
    logger.error(`Failed to parse Paycrest webhook: ${error.message}`);
    return res.status(400).send('Invalid JSON.');
  }

  const event = parsedBody.event;
  const data = parsedBody.data;
  logger.info(`Received Paycrest event: ${event}`);

  try {
    const orderId = data.id;
    const reference = data.reference;
    const status = data.status;
    const amountPaid = parseFloat(data.amountPaid) || 0;

    const txSnapshot = await db.collection('transactions')
      .where('paycrestOrderId', '==', orderId)
      .limit(1)
      .get();

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
    const userState = await getUserState(userId);
    const userFirstName = userState.firstName || 'valued user';

    const adminLog = `*User:* ${userFirstName} (ID: ${userId})\n`
      + `*Reference ID:* ${reference}\n`
      + `*Asset:* ${txData.asset}\n`
      + `*Network:* ${txData.chain}\n`
      + `*Transaction Hash:* \`${txData.transactionHash || 'N/A'}\`\n`;

    switch (event) {
      case 'payment_order.pending':
        // Admin only
        await bot.telegram.sendMessage(
          PERSONAL_CHAT_ID,
          `🔄 *Payment Order Pending*\n\n${adminLog}`,
          { parse_mode: 'Markdown' }
        );
        await txDoc.ref.update({ status: 'Pending' });
        break;

      case 'payment_order.settled':
        // 12. Payout Success (Paycrest Settled)
        const successEng = `🎉 *Funds Credited Successfully!*\n\nHello ${txData.bankDetails.accountName},\nYour DirectPay order has been completed. Here are the details:\n*Crypto Amount:* ${txData.amount} ${txData.asset}\n*Cash Amount:* NGN ${txData.payout}\n*Network:* ${txData.chain}\n*Date:* ${new Date(txData.timestamp).toLocaleString()}\n\nThank you for using *DirectPay*!`;
        const successPidgin = `🎉 *Money Don Enter Finish!*\n\nHello ${txData.bankDetails.accountName},\nYour DirectPay order don complete. See the details:\n*Crypto Amount:* ${txData.amount} ${txData.asset}\n*Cash Amount:* NGN ${txData.payout}\n*Network:* ${txData.chain}\n*Date:* ${new Date(txData.timestamp).toLocaleString()}\n\nThank you say you use *DirectPay*!`;

        await bot.telegram.sendPhoto(
          userId,
          { source: PAYOUT_SUCCESS_IMAGE },
          {
            caption: userState.usePidgin ? successPidgin : successEng,
            parse_mode: 'Markdown'
          }
        );
        await txDoc.ref.update({ status: 'Completed' });

        // Admin log
        await bot.telegram.sendMessage(
          PERSONAL_CHAT_ID,
          `✅ *Payment Order Settled*\n\n${adminLog}`,
          { parse_mode: 'Markdown' }
        );
        break;

      case 'payment_order.refunded':
        // Send user a short message (no fiat)
        const refundEng = `Hello ${userFirstName},\n\nYour DirectPay order with reference \`${reference}\` has been refunded.\n\n*Crypto amount:* ${txData.amount} ${txData.asset}\n*Network:* ${txData.chain}\n*Transaction Hash:* \`${txData.transactionHash}\`\n\nIf you have any questions, please contact support.`;
        const refundPidgin = `Hello ${userFirstName},\n\nYour DirectPay order wey get reference \`${reference}\` don refund.\n\n*Crypto amount:* ${txData.amount} ${txData.asset}\n*Network:* ${txData.chain}\n*Transaction Hash:* \`${txData.transactionHash}\`\n\nIf you get any issue, abeg contact support.`;

        await bot.telegram.sendMessage(
          userId,
          userState.usePidgin ? refundPidgin : refundEng,
          { parse_mode: 'Markdown' }
        );
        await txDoc.ref.update({ status: 'Refunded' });

        await bot.telegram.sendMessage(
          PERSONAL_CHAT_ID,
          `❌ *Payment Order Refunded*\n\n${adminLog}`,
          { parse_mode: 'Markdown' }
        );
        break;

      case 'payment_order.expired':
        // Notify user + admin
        const expiredEng = `Hello ${userFirstName}, your DirectPay order \`${reference}\` has expired.`;
        const expiredPidgin = `Hello ${userFirstName}, your DirectPay order \`${reference}\` don expire.`;
        await bot.telegram.sendMessage(
          userId,
          userState.usePidgin ? expiredPidgin : expiredEng,
          { parse_mode: 'Markdown' }
        );
        await txDoc.ref.update({ status: 'Expired' });

        await bot.telegram.sendMessage(
          PERSONAL_CHAT_ID,
          `⏰ *Payment Order Expired*\n\n${adminLog}`,
          { parse_mode: 'Markdown' }
        );
        break;

      default:
        logger.info(`Unhandled Paycrest event: ${event}`);
    }

    return res.status(200).send('OK');
  } catch (error) {
    logger.error(`Error processing Paycrest webhook: ${error.message}`);
    await bot.telegram.sendMessage(
      PERSONAL_CHAT_ID,
      `❗️ Error processing Paycrest webhook: ${error.message}`,
      { parse_mode: 'Markdown' }
    );
    return res.status(500).send('Error');
  }
});

function verifyPaycrestSignature(requestBody, signatureHeader, secretKey) {
  const hmac = crypto.createHmac('sha256', secretKey);
  hmac.update(requestBody);
  const calc = hmac.digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(signatureHeader));
  } catch {
    return false;
  }
}

/*****************************************
 *       Blockradar Webhook
 *****************************************/
app.post(WEBHOOK_BLOCKRADAR_PATH, bodyParser.json(), async (req, res) => {
  try {
    const event = req.body;
    if (!event) {
      logger.error('No event data found in Blockradar webhook.');
      return res.status(400).send('No event data.');
    }
    logger.info(`Received Blockradar webhook: ${JSON.stringify(event)}`);
    fs.appendFileSync(path.join(__dirname, 'webhook_logs.txt'), `${new Date().toISOString()} - ${JSON.stringify(event, null, 2)}\n`);

    const eventType = event.event || 'Unknown Event';
    const walletAddress = event.data?.recipientAddress || 'N/A';
    const amount = parseFloat(event.data?.amount) || 0;
    const asset = event.data?.asset?.symbol || 'N/A';
    const transactionHash = event.data?.hash || 'N/A';
    const chainRaw = event.data?.blockchain?.name || 'N/A';

    if (eventType === 'deposit.success') {
      if (walletAddress === 'N/A') {
        logger.error('Missing wallet address in deposit.success');
        return res.status(400).send('Missing address.');
      }
      // Check if transaction already exists
      const existingTx = await db.collection('transactions')
        .where('transactionHash', '==', transactionHash)
        .get();
      if (!existingTx.empty) {
        logger.info(`Tx hash ${transactionHash} already recorded.`);
        return res.status(200).send('OK');
      }

      // Find user
      const userDocs = await db.collection('users')
        .where('walletAddresses', 'array-contains', walletAddress)
        .get();
      if (userDocs.empty) {
        logger.warn(`No user found for wallet: ${walletAddress}`);
        await bot.telegram.sendMessage(
          PERSONAL_CHAT_ID,
          `No user found for wallet: \`${walletAddress}\``
        );
        return res.status(200).send('OK');
      }

      const userDoc = userDocs.docs[0];
      const userId = userDoc.id;
      const userData = userDoc.data();
      const wallet = userData.wallets.find(w => w.address === walletAddress);

      if (!wallet || !wallet.bank) {
        const noBankMsg = userData.usePidgin
          ? `🎉 *Deposit Don Land!*\n\nAmount: ${amount} ${asset} for ${chainRaw}\nBut you never link bank account o!`
          : `🎉 *Deposit Received!*\n\nAmount: ${amount} ${asset} on ${chainRaw}\nBut you haven’t linked a bank account yet!`;
        await bot.telegram.sendMessage(userId, noBankMsg, { parse_mode: 'Markdown' });
        await bot.telegram.sendMessage(
          PERSONAL_CHAT_ID,
          `User ${userId} has deposit but no bank linked.`
        );
        return res.status(200).send('OK');
      }

      if (!['USDC', 'USDT'].includes(asset)) {
        const unsupMsg = userData.usePidgin
          ? `⚠️ *Unsupported Asset:* ${asset}. We only accept USDC/USDT.`
          : `⚠️ *Unsupported Asset:* ${asset}. Only USDC/USDT accepted.`;
        await bot.telegram.sendMessage(userId, unsupMsg, { parse_mode: 'Markdown' });
        await bot.telegram.sendMessage(
          PERSONAL_CHAT_ID,
          `User ${userId} tried unsupported asset: ${asset}`
        );
        return res.status(200).send('OK');
      }

      // Calculate approximate NGN
      const paycrestRate = exchangeRates[asset] || 0;
      const serviceFeePercent = 0.5;
      const ngnAmount = calculatePayoutWithFee(amount, paycrestRate, serviceFeePercent);

      const referenceId = generateReferenceId();
      const { bankName, accountNumber, accountName } = wallet.bank;
      const userFirstName = userData.firstName || 'valued user';

      const txRef = await db.collection('transactions').add({
        userId,
        walletAddress,
        chain: chainRaw,
        amount,
        asset,
        transactionHash,
        referenceId,
        bankDetails: { bankName, accountNumber, accountName },
        payout: ngnAmount,
        timestamp: new Date().toISOString(),
        status: 'Pending',
        paycrestOrderId: '',
        messageId: null,
        firstName: userFirstName
      });

      // 10. Deposit Received (Blockradar Webhook)
      const depositEng = `🎉 *Deposit Received!*\n\n*Amount:* ${amount} ${asset} on ${chainRaw}\n*Reference ID:* \`${referenceId}\`\n*Exchange Rate:* ₦${paycrestRate} per ${asset} (Blockradar)\n*Estimated Payout:* ₦${ngnAmount}\n*Time:* ${new Date().toLocaleString()}\n*Bank Details:*\n  - *Account Name:* ${accountName}\n  - *Bank:* ${bankName}\n  - *Account Number:* ****${accountNumber.slice(-4)}\n\nYour funds have arrived, ${userFirstName}! We’re processing it now—please wait for the payout to reach your account. Thank you for using *DirectPay*!`;
      const depositPidgin = `🎉 *Deposit Don Land!*\n\n*Amount:* ${amount} ${asset} for ${chainRaw}\n*Reference ID:* \`${referenceId}\`\n*Exchange Rate:* ₦${paycrestRate} per ${asset} (Blockradar)\n*Estimated Payout:* ₦${ngnAmount}\n*Time:* ${new Date().toLocaleString()}\n*Bank Details:*\n  - *Account Name:* ${accountName}\n  - *Bank:* ${bankName}\n  - *Account Number:* ****${accountNumber.slice(-4)}\n\nYour money don enter, ${userFirstName}! We dey process am now—abeg wait small make e reach your account. Thank you say you use *DirectPay*!`;

      const caption = userData.usePidgin ? depositPidgin : depositEng;
      const sentMsg = await bot.telegram.sendPhoto(userId, { source: DEPOSIT_SUCCESS_IMAGE }, {
        caption,
        parse_mode: 'Markdown'
      });

      // store messageId
      await txRef.update({ messageId: sentMsg.message_id });

      // update wallet stats
      wallet.totalDeposits = (wallet.totalDeposits || 0) + amount;
      wallet.totalPayouts = (wallet.totalPayouts || 0) + ngnAmount;
      await updateUserState(userId, { wallets: userData.wallets });

      // Admin log
      await bot.telegram.sendMessage(
        PERSONAL_CHAT_ID,
        `New deposit from user ${userId}:\nAsset: ${amount} ${asset}, chain: ${chainRaw}, ref: ${referenceId}`
      );

      return res.status(200).send('OK');
    }

    // If you handle "deposit.swept.success" or other events, do so similarly
    return res.status(200).send('OK');
  } catch (error) {
    logger.error(`Error in Blockradar webhook: ${error.message}`);
    await bot.telegram.sendPhoto(PERSONAL_CHAT_ID, { source: ERROR_IMAGE }, {
      caption: `❗️ Error processing Blockradar webhook: ${error.message}`,
      parse_mode: 'Markdown'
    });
    return res.status(500).send('Error processing webhook');
  }
});

/*****************************************
 *         Telegram Webhook
 *****************************************/
app.use(WEBHOOK_PATH, bodyParser.json());
app.post(WEBHOOK_PATH, bodyParser.json(), (req, res) => {
  if (!req.body) {
    logger.error('No body in Telegram webhook request.');
    return res.status(400).send('No body found.');
  }
  const clientIp = requestIp.getClientIp(req);
  logger.info(`Received Telegram update from IP ${clientIp}: ${JSON.stringify(req.body, null, 2)}`);
  bot.handleUpdate(req.body, res);
});

/*****************************************
 *        Start Express Server
 *****************************************/
const SERVER_PORT = PORT;
app.listen(SERVER_PORT, () => {
  logger.info(`Webhook server running on port ${SERVER_PORT}`);
});

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
