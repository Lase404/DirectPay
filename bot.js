
const Web3 = require('web3');
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const admin = require('firebase-admin');
const express = require('express');
const fs = require('fs');
const path = require('path');

// Firebase setup with Enhanced Error Handling
let db;
try {
  const serviceAccountPath = '.directpayngn-firebase-adminsdk-d11t3-17c3c57aa5.json';
  if (!fs.existsSync(serviceAccountPath)) {
    console.error(`Service account key file not found at path: ${serviceAccountPath}`);
    process.exit(1);
  }

  const serviceAccount = require(serviceAccountPath);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: 'https://directpayngn.firebaseio.com',
  });

  db = admin.firestore();
  console.log('✅ Firebase initialized successfully.');
} catch (error) {
  console.error('❌ Failed to initialize Firebase:', error.message);
  process.exit(1); // Exit the process if Firebase initialization fails
}

// Config & API Keys (Hardcoded as per instruction)
const BOT_TOKEN = '7404771579:AAEY0HpgC-3ZmFGq0-bToPkAczGbJ-WND-Q';
const PAYSTACK_API_KEY = 'sk_test_cd857e88d5d474db8238d30d027ea2911cd7fa17';
const BLOCKRADAR_API_KEY = 'grD8lJpMPjvjChMo5SnOl0eZmaabikn2z2S2rXKkAxCM1oWsZDMwFQL9LWgrc';
const BLOCKRADAR_WALLET_ID = '83eeb82c-bf7b-4e70-bdd0-ab87b4fbcc2d';
const PERSONAL_CHAT_ID = '2009305288';

// Web3 Setup for Base Testnet
const web3 = new Web3('https://sepolia.base.org');

// Bot Initialization
const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());

// State Management
let userStates = {}; // In-memory cache of user states
const MAX_WALLETS = 3; // Max wallets per user

// Manual Bank List with Aliases
const bankList = [
  { name: '9mobile 9Payment Service Bank', code: '120001', aliases: ['9PSB', '9mobile PSB'] },
  { name: 'Abbey Mortgage Bank', code: '801', aliases: ['Abbey Mortgage'] },
  { name: 'Above Only MFB', code: '51204', aliases: ['Above Only Microfinance Bank'] },
  { name: 'Abulesoro MFB', code: '51312', aliases: ['Abulesoro Microfinance Bank'] },
  { name: 'Access Bank', code: '044', aliases: ['Access', 'Diamond Bank'] },
  { name: 'Access Bank (Diamond)', code: '063', aliases: ['Access Diamond', 'Diamond Bank'] },
  { name: 'Airtel Smartcash PSB', code: '120004', aliases: ['Smartcash', 'Airtel PSB'] },
  { name: 'ALAT by WEMA', code: '035A', aliases: ['ALAT', 'Wema ALAT'] },
  { name: 'Amju Unique MFB', code: '50926', aliases: ['Amju Unique Microfinance Bank'] },
  { name: 'Aramoko MFB', code: '50083', aliases: ['Aramoko Microfinance Bank'] },
  { name: 'ASO Savings and Loans', code: '401', aliases: ['ASO Savings'] },
  { name: 'Astrapolaris MFB LTD', code: 'MFB50094', aliases: ['Astrapolaris Microfinance Bank'] },
  { name: 'Bainescredit MFB', code: '51229', aliases: ['Bainescredit Microfinance Bank'] },
  { name: 'Bowen Microfinance Bank', code: '50931', aliases: ['Bowen MFB'] },
  { name: 'Carbon', code: '565', aliases: ['Paylater'] },
  { name: 'CEMCS Microfinance Bank', code: '50823', aliases: ['CEMCS MFB'] },
  { name: 'Chanelle Microfinance Bank Limited', code: '50171', aliases: ['Chanelle MFB'] },
  { name: 'Citibank Nigeria', code: '023', aliases: ['Citibank', 'Citi Bank'] },
  { name: 'Corestep MFB', code: '50204', aliases: ['Corestep Microfinance Bank'] },
  { name: 'Coronation Merchant Bank', code: '559', aliases: ['Coronation Bank'] },
  { name: 'Crescent MFB', code: '51297', aliases: ['Crescent Microfinance Bank'] },
  { name: 'Ecobank Nigeria', code: '050', aliases: ['Ecobank'] },
  { name: 'Ekimogun MFB', code: '50263', aliases: ['Ekimogun Microfinance Bank'] },
  { name: 'Ekondo Microfinance Bank', code: '562', aliases: ['Ekondo MFB'] },
  { name: 'Eyowo', code: '50126', aliases: ['Eyowo Microfinance Bank'] },
  { name: 'Fidelity Bank', code: '070', aliases: ['Fidelity'] },
  { name: 'Firmus MFB', code: '51314', aliases: ['Firmus Microfinance Bank'] },
  { name: 'First Bank of Nigeria', code: '011', aliases: ['First Bank', 'FBN'] },
  { name: 'First City Monument Bank', code: '214', aliases: ['FCMB'] },
  { name: 'FSDH Merchant Bank Limited', code: '501', aliases: ['FSDH Bank'] },
  { name: 'Gateway Mortgage Bank LTD', code: '812', aliases: ['Gateway Mortgage Bank'] },
  { name: 'Globus Bank', code: '00103', aliases: ['Globus'] },
  { name: 'GoMoney', code: '100022', aliases: ['Go Money'] },
  { name: 'Guaranty Trust Bank', code: '058', aliases: ['GTBank', 'GTB', 'Guarantee Trust Bank'] },
  { name: 'Hackman Microfinance Bank', code: '51251', aliases: ['Hackman MFB'] },
  { name: 'Hasal Microfinance Bank', code: '50383', aliases: ['Hasal MFB'] },
  { name: 'Heritage Bank', code: '030', aliases: ['Heritage'] },
  { name: 'HopePSB', code: '120002', aliases: ['Hope PSB'] },
  { name: 'Ibile Microfinance Bank', code: '51244', aliases: ['Ibile MFB'] },
  { name: 'Ikoyi Osun MFB', code: '50439', aliases: ['Ikoyi Osun Microfinance Bank'] },
  { name: 'Infinity MFB', code: '50457', aliases: ['Infinity Microfinance Bank'] },
  { name: 'Jaiz Bank', code: '301', aliases: ['Jaiz'] },
  { name: 'Kadpoly MFB', code: '50502', aliases: ['Kadpoly Microfinance Bank'] },
  { name: 'Keystone Bank', code: '082', aliases: ['Keystone'] },
  { name: 'Kredi Money MFB LTD', code: '50200', aliases: ['Kredi Money'] },
  { name: 'Kuda Bank', code: '50211', aliases: ['Kuda'] },
  { name: 'Lagos Building Investment Company Plc.', code: '90052', aliases: ['LBIC'] },
  { name: 'Links MFB', code: '50549', aliases: ['Links Microfinance Bank'] },
  { name: 'Living Trust Mortgage Bank', code: '031', aliases: ['Living Trust Bank'] },
  { name: 'Lotus Bank', code: '303', aliases: ['Lotus'] },
  { name: 'Mayfair MFB', code: '50563', aliases: ['Mayfair Microfinance Bank'] },
  { name: 'Mint MFB', code: '50304', aliases: ['Mint Microfinance Bank'] },
  { name: 'MTN Momo PSB', code: '120003', aliases: ['Momo PSB', 'MTN PSB'] },
  { name: 'Paga', code: '100002', aliases: ['Pagatech', 'PagaPay'] },
  { name: 'PalmPay', code: '999991', aliases: ['Palm Pay'] },
  { name: 'Parallex Bank', code: '104', aliases: ['Parallex'] },
  { name: 'Parkway - ReadyCash', code: '311', aliases: ['ReadyCash', 'Parkway'] },
  { name: 'Paycom', code: '999992', aliases: ['OPay', 'Paycom'] },
  { name: 'Petra Mircofinance Bank Plc', code: '50746', aliases: ['Petra MFB'] },
  { name: 'Polaris Bank', code: '076', aliases: ['Polaris'] },
  { name: 'Polyunwana MFB', code: '50864', aliases: ['Polyunwana Microfinance Bank'] },
  { name: 'PremiumTrust Bank', code: '105', aliases: ['Premium Trust Bank'] },
  { name: 'Providus Bank', code: '101', aliases: ['Providus'] },
  { name: 'QuickFund MFB', code: '51293', aliases: ['QuickFund Microfinance Bank'] },
  { name: 'Rand Merchant Bank', code: '502', aliases: ['RMB'] },
  { name: 'Refuge Mortgage Bank', code: '90067', aliases: ['Refuge Mortgage'] },
  { name: 'Rubies MFB', code: '125', aliases: ['Rubies Bank'] },
  { name: 'Safe Haven MFB', code: '51113', aliases: ['Safe Haven Microfinance Bank'] },
  { name: 'Solid Rock MFB', code: '50800', aliases: ['Solid Rock Microfinance Bank'] },
  { name: 'Sparkle Microfinance Bank', code: '51310', aliases: ['Sparkle'] },
  { name: 'Stanbic IBTC Bank', code: '221', aliases: ['Stanbic', 'IBTC', 'Stanbic Bank'] },
  { name: 'Standard Chartered Bank', code: '068', aliases: ['Standard Chartered', 'StanChart'] },
  { name: 'Stellas MFB', code: '51253', aliases: ['Stellas Microfinance Bank'] },
  { name: 'Sterling Bank', code: '232', aliases: ['Sterling'] },
  { name: 'Suntrust Bank', code: '100', aliases: ['SunTrust'] },
  { name: 'TAJ Bank', code: '302', aliases: ['TAJ'] },
  { name: 'Tangerine Money', code: '51269', aliases: ['Tangerine'] },
  { name: 'TCF MFB', code: '51211', aliases: ['TCF Microfinance Bank'] },
  { name: 'Titan Bank', code: '102', aliases: ['Titan Trust Bank'] },
  { name: 'Titan Paystack', code: '100039', aliases: ['Paystack Bank'] },
  { name: 'Unical MFB', code: '50871', aliases: ['Unical Microfinance Bank'] },
  { name: 'Union Bank of Nigeria', code: '032', aliases: ['Union Bank'] },
  { name: 'United Bank For Africa', code: '033', aliases: ['UBA'] },
  { name: 'Unity Bank', code: '215', aliases: ['Unity'] },
  { name: 'VFD Microfinance Bank Limited', code: '566', aliases: ['VFD MFB', 'V Bank'] },
  { name: 'Wema Bank', code: '035', aliases: ['Wema'] },
  { name: 'Zenith Bank', code: '057', aliases: ['Zenith'] },
];

// Utility Functions

/**
 * Verifies a bank account using Paystack API.
 * @param {string} accountNumber
 * @param {string} bankCode
 * @returns {object} Verification result
 */
async function verifyBankAccount(accountNumber, bankCode) {
  try {
    const response = await axios.get(`https://api.paystack.co/bank/resolve`, {
      params: { account_number: accountNumber, bank_code: bankCode },
      headers: { Authorization: `Bearer ${PAYSTACK_API_KEY}` },
    });
    return response.data;
  } catch (error) {
    console.error('Error verifying bank account:', error.response?.data || error.message);
    throw new Error('Failed to verify bank account. Please ensure your details are correct.');
  }
}

/**
 * Calculates payout based on asset type.
 * @param {string} asset
 * @param {number} amount
 * @returns {string} Payout amount in NGN
 */
function calculatePayout(asset, amount) {
  const rates = { USDC: 1641.81, USDT: 1641.81, ETH: 3968483.33 };
  return (amount * rates[asset]).toFixed(2);
}

/**
 * Retrieves the exchange rate for a given asset.
 * @param {string} asset
 * @returns {number} Exchange rate
 */
function getRate(asset) {
  const rates = { USDC: 1641.81, USDT: 1641.81, ETH: 3968483.33 };
  return rates[asset];
}

/**
 * Generates a unique reference ID for transactions.
 * @returns {string} Reference ID
 */
function generateReferenceId() {
  return 'REF-' + Math.random().toString(36).substr(2, 9).toUpperCase();
}

/**
 * Generates the main menu keyboard based on wallet status.
 * @param {boolean} walletExists
 * @returns {Markup} Keyboard markup
 */
const getMainMenu = (walletExists) =>
  Markup.keyboard([
    [walletExists ? '💼 View Wallet' : '💼 Generate Wallet', '🏦 Link Bank Account'],
    ['💰 Transactions', 'ℹ️ Support', '📘 Learn About Base'],
  ]).resize();

/**
 * Generates the admin-only inline keyboard.
 * @returns {Markup} Inline keyboard markup
 */
const adminMenu = Markup.inlineKeyboard([
  [Markup.button.callback('View Transactions', 'admin_view_transactions')],
  [Markup.button.callback('Send Message', 'admin_send_message')],
  [Markup.button.callback('Mark Paid', 'admin_mark_paid')],
  [Markup.button.callback('Upload Image to User', 'admin_upload_image')],
]);

/**
 * Checks if a user is an admin.
 * @param {string} userId
 * @returns {boolean}
 */
const isAdmin = (userId) => userId.toString() === PERSONAL_CHAT_ID;

/**
 * Retrieves the user state from Firestore or initializes it.
 * @param {string} userId
 * @returns {object} User state
 */
async function getUserState(userId) {
  try {
    if (userStates[userId]) {
      return userStates[userId];
    }
    const doc = await db.collection('userStates').doc(userId).get();
    if (doc.exists) {
      userStates[userId] = doc.data();
      return userStates[userId];
    } else {
      userStates[userId] = { wallets: [], bankDetails: null, hasReceivedDeposit: false };
      return userStates[userId];
    }
  } catch (error) {
    console.error(`Error fetching user state for ${userId}:`, error.message);
    throw new Error('Internal server error. Please try again later.');
  }
}

/**
 * Saves the user state to Firestore.
 * @param {string} userId
 */
async function saveUserState(userId) {
  try {
    const userState = userStates[userId];
    if (userState) {
      await db.collection('userStates').doc(userId).set(userState);
    }
  } catch (error) {
    console.error(`Error saving user state for ${userId}:`, error.message);
  }
}

/**
 * Greets the user upon starting the bot.
 * @param {Context} ctx
 */
async function greetUser(ctx) {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    const walletExists = userState.wallets.length > 0;

    const greeting = walletExists
      ? `👋 Hey, ${ctx.from.first_name}! Welcome back onchain with DirectPay! 🚀\n\nYour seamless journey continues. Manage your wallets and transactions below, and keep enjoying instant cashouts from your crypto assets. Let's keep things rolling!`
      : `👋 Hello, ${ctx.from.first_name}! Welcome to DirectPay!\n\nSay goodbye to delays and complicated P2P transactions. With DirectPay, you can easily send stablecoins and receive cash directly in your bank account within minutes. No KYC, no hassle—just quick and secure transactions.\n\nLet’s get started!\n\n1. **Add Your Bank Account**\n2. **Get Your Dedicated Wallet Address**\n3. **Send Stablecoins and receive cash instantly.**\n\nWe’ve got the best rates and real-time updates to keep you informed every step of the way. Your funds are safe, and you’ll have cash in your account in no time!`;

    // Send greeting message
    await ctx.replyWithMarkdown(greeting, getMainMenu(walletExists));

    // If user is admin, send admin menu
    if (isAdmin(userId)) {
      await ctx.reply('🔑 Welcome to the Admin Panel:', adminMenu);
    }
  } catch (error) {
    console.error(`Error in greetUser for ${userId}:`, error.message);
    await ctx.reply('❌ An error occurred while processing your request. Please try again later.');
  }
}

// Handle /start Command
bot.start(async (ctx) => {
  await greetUser(ctx);
});

// Generate Wallet Function
async function generateBaseWallet() {
  try {
    const response = await axios.post(
      `https://api.blockradar.co/v1/wallets/${BLOCKRADAR_WALLET_ID}/addresses`,
      { name: 'DirectPay_User_Wallet' },
      { headers: { 'x-api-key': BLOCKRADAR_API_KEY } }
    );
    return response.data.data.address;
  } catch (error) {
    console.error('Error generating wallet:', error.response?.data || error.message);
    throw new Error('Error generating wallet. Please try again later.');
  }
}

// Wallet Generation and Viewing

// Generate Wallet
bot.hears('💼 Generate Wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);

    if (userState.wallets.length >= MAX_WALLETS) {
      return ctx.reply(`⚠️ You cannot generate more than ${MAX_WALLETS} wallets.`);
    }

    const generatingMessage = await ctx.reply('🔄 Generating Wallet... Please wait a moment.');

    const walletAddress = await generateBaseWallet();
    userState.wallets.push({ address: walletAddress, bank: null });
    await saveUserState(userId); // Save user state

    // Save wallet address mapping
    await db.collection('walletAddresses').doc(walletAddress).set({ userId });

    // Update Menu
    await ctx.replyWithMarkdown(
      `✅ Success! Your new wallet has been generated:\n\n\`${walletAddress}\``,
      getMainMenu(true)
    );

    // Prompt to Link Bank Account
    await ctx.reply('Please link a bank account to receive your payouts.', Markup.keyboard(['🏦 Link Bank Account']).resize());

    await ctx.deleteMessage(generatingMessage.message_id);

    // Log Wallet Generation
    await bot.telegram.sendMessage(
      PERSONAL_CHAT_ID,
      `💼 Wallet generated for user ${userId} (@${ctx.from.username || 'N/A'}): ${walletAddress}`
    );
  } catch (error) {
    console.error(`Error generating wallet for ${userId}:`, error.message);
    await ctx.reply('⚠️ There was an issue generating your wallet. Please try again later.');
    await bot.telegram.sendMessage(
      PERSONAL_CHAT_ID,
      `❗️ Error generating wallet for user ${userId}: ${error.message}`
    );
  }
});

// View Wallet
bot.hears('💼 View Wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);

    if (userState.wallets.length === 0) {
      return ctx.reply('You have no wallets. Generate a new wallet below.', getMainMenu(false));
    }

    // Display Wallets
    let walletMessage = '💼 **Your Wallets**:\n\n';
    userState.wallets.forEach((wallet, index) => {
      walletMessage += `#${index + 1} Wallet Address: \`${wallet.address}\`\n`;
      walletMessage += `🔗 Linked Bank: ${wallet.bank ? 'Yes' : 'No'}\n\n`;
    });

    const canCreateNewWallet = userState.wallets[0].bank;

    await ctx.replyWithMarkdown(
      walletMessage,
      Markup.inlineKeyboard([
        canCreateNewWallet
          ? [Markup.button.callback('Create New Wallet', 'create_new_wallet')]
          : [Markup.button.callback('Link Bank to Create New Wallet', 'link_bank')],
      ])
    );
  } catch (error) {
    console.error(`Error viewing wallets for ${userId}:`, error.message);
    await ctx.reply('❌ Unable to fetch your wallets. Please try again later.');
  }
});

// Create New Wallet
bot.action('create_new_wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);

    if (!userState.wallets[0].bank) {
      return ctx.reply('⚠️ You must link a bank to your first wallet before creating a new one.');
    }

    if (userState.wallets.length >= MAX_WALLETS) {
      return ctx.reply(`⚠️ You cannot generate more than ${MAX_WALLETS} wallets.`);
    }

    const generatingMessage = await ctx.reply('🔄 Generating a new wallet... Please wait a moment.');

    const walletAddress = await generateBaseWallet();
    userState.wallets.push({ address: walletAddress, bank: null });
    await saveUserState(userId); // Save user state

    // Save wallet address mapping
    await db.collection('walletAddresses').doc(walletAddress).set({ userId });

    await ctx.replyWithMarkdown(
      `✅ Success! Your new wallet has been generated:\n\n\`${walletAddress}\``,
      getMainMenu(true)
    );

    await ctx.deleteMessage(generatingMessage.message_id);

    // Log Wallet Generation
    await bot.telegram.sendMessage(
      PERSONAL_CHAT_ID,
      `💼 New wallet generated for user ${userId} (@${ctx.from.username || 'N/A'}): ${walletAddress}`
    );
  } catch (error) {
    console.error(`Error generating new wallet for ${userId}:`, error.message);
    await ctx.reply('⚠️ There was an issue generating your wallet. Please try again later.');
    await bot.telegram.sendMessage(
      PERSONAL_CHAT_ID,
      `❗️ Error generating new wallet for user ${userId}: ${error.message}`
    );
  }
});

// Link Bank Account
bot.hears('🏦 Link Bank Account', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);

    // Check if user has wallets
    if (userState.wallets.length === 0) {
      return ctx.reply('⚠️ You need to generate a wallet before linking a bank account.');
    }

    // Find the first wallet without a linked bank
    const walletIndex = userState.wallets.findIndex((wallet) => !wallet.bank);

    if (walletIndex === -1) {
      return ctx.reply('All your wallets already have a linked bank account.');
    }

    userState.currentWalletIndex = walletIndex;
    userState.awaitingBankName = true;
    await saveUserState(userId); // Save user state

    await ctx.reply('Please enter your bank name (e.g., Access Bank):');
  } catch (error) {
    console.error(`Error initiating bank linking for ${userId}:`, error.message);
    await ctx.reply('❌ An error occurred. Please try again later.');
  }
});

// Handle Bank Name and Account Number Input
bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);

    if (userState.awaitingBankName) {
      const bankNameInput = ctx.message.text.trim().toLowerCase();
      const bank = bankList.find((b) =>
        b.aliases.map((alias) => alias.toLowerCase()).includes(bankNameInput)
      );

      if (!bank) {
        return ctx.reply('❌ Invalid bank name. Please enter a valid bank name:');
      }

      userState.bankCode = bank.code;
      userState.bankName = bank.name;
      userState.awaitingBankName = false;
      userState.awaitingAccountNumber = true;
      await saveUserState(userId); // Save user state

      return ctx.reply('Please enter your bank account number (10 digits):');
    } else if (userState.awaitingAccountNumber) {
      const accountNumber = ctx.message.text.trim();

      if (!/^\d{10}$/.test(accountNumber)) {
        return ctx.reply('❌ Invalid account number. Please enter a valid 10-digit account number:');
      }

      userState.accountNumber = accountNumber;
      await saveUserState(userId); // Save user state

      // Verify Bank Account
      await ctx.reply('🔄 Verifying your bank details...');

      try {
        const verificationResult = await verifyBankAccount(accountNumber, userState.bankCode);

        const accountName = verificationResult.data.account_name;
        if (!accountName) {
          throw new Error('Account name not found.');
        }

        userState.accountName = accountName;
        await saveUserState(userId); // Save user state

        // Ask for Confirmation
        await ctx.replyWithMarkdown(
          `🏦 **Bank Account Verification**\n\nBank Name: *${userState.bankName}*\nAccount Number: *${userState.accountNumber}*\nAccount Holder: *${accountName}*\n\nIs this correct?`,
          Markup.inlineKeyboard([
            Markup.button.callback('✅ Yes', 'confirm_bank_yes'),
            Markup.button.callback('❌ No', 'confirm_bank_no'),
          ])
        );
      } catch (error) {
        console.error(`Error verifying bank account for ${userId}:`, error.message);
        await ctx.reply('❌ Failed to verify bank account. Please ensure your details are correct and try again.');
        userState.awaitingBankName = true;
        userState.awaitingAccountNumber = false;
        await saveUserState(userId); // Save user state
        return ctx.reply('Please enter your bank name:');
      }

      userState.awaitingAccountNumber = false;
      await saveUserState(userId); // Save user state
    } else if (isAdmin(userId) && userState.awaitingUserIdForMessage) {
      // Handle Admin Messaging
      const recipientId = ctx.message.text.trim();
      if (!recipientId.match(/^\d+$/)) {
        return ctx.reply('❌ Invalid User ID. Please enter a numerical User ID:');
      }
      userState.messageRecipientId = recipientId;
      userState.awaitingUserIdForMessage = false;
      userState.awaitingMessageContent = true;
      await saveUserState(userId); // Save user state
      return ctx.reply('Please enter the message you want to send:');
    } else if (isAdmin(userId) && userState.awaitingMessageContent) {
      const recipientId = userState.messageRecipientId;
      const messageContent = ctx.message.text.trim();

      try {
        await bot.telegram.sendMessage(recipientId, `📩 Message from Admin:\n\n${messageContent}`);
        await ctx.reply('✅ Message sent successfully.');
      } catch (error) {
        console.error(`Error sending message to user ${recipientId}:`, error.message);
        await ctx.reply('⚠️ Failed to send message to the user. Please ensure the User ID is correct.');
      }

      // Reset Admin State
      userState.messageRecipientId = null;
      userState.awaitingMessageContent = false;
      await saveUserState(userId); // Save user state
    } else if (isAdmin(userId) && userState.awaitingUserIdForImage) {
      // Handle Admin Image Upload
      const recipientId = ctx.message.text.trim();
      if (!recipientId.match(/^\d+$/)) {
        return ctx.reply('❌ Invalid User ID. Please enter a numerical User ID:');
      }
      userState.imageRecipientId = recipientId;
      userState.awaitingUserIdForImage = false;
      userState.awaitingImage = true;
      await saveUserState(userId); // Save user state
      return ctx.reply('Please upload the image you want to send:');
    } else {
      // If none of the conditions match, you can handle other text messages here
      return;
    }
  } catch (error) {
    console.error(`Error handling text message from ${userId}:`, error.message);
    await ctx.reply('❌ An error occurred while processing your request. Please try again later.');
  }
});

// Handle Bank Confirmation
bot.action('confirm_bank_yes', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    const walletIndex = userState.currentWalletIndex;

    if (walletIndex === undefined || walletIndex === null) {
      return ctx.reply('❌ An error occurred. Please restart the bank linking process by clicking on "🏦 Link Bank Account".');
    }

    const wallet = userState.wallets[walletIndex];
    if (!wallet) {
      return ctx.reply('❌ Wallet not found. Please restart the bank linking process.');
    }

    // Link Bank to Wallet
    wallet.bank = {
      bankName: userState.bankName,
      bankCode: userState.bankCode,
      accountNumber: userState.accountNumber,
      accountName: userState.accountName,
    };

    // Reset Temp States
    userState.bankName = null;
    userState.bankCode = null;
    userState.accountNumber = null;
    userState.accountName = null;
    userState.currentWalletIndex = null;
    userState.awaitingBankName = false;
    userState.awaitingAccountNumber = false;
    await saveUserState(userId); // Save user state

    await ctx.reply('✅ Your bank account has been linked successfully!', getMainMenu(true));

    // Log to Admin with Enhanced Information
    await bot.telegram.sendMessage(
      PERSONAL_CHAT_ID,
      `🔗 User ${userId} (@${ctx.from.username || 'N/A'}) linked a bank account:\n` +
      `🏦 Bank Name: ${wallet.bank.bankName}\n` +
      `🔢 Account Number: ${wallet.bank.accountNumber}\n` +
      `👤 Account Name: ${wallet.bank.accountName}`
    );
  } catch (error) {
    console.error(`Error confirming bank link for ${userId}:`, error.message);
    await ctx.reply('❌ An error occurred while linking your bank account. Please try again later.');
  }
});

bot.action('confirm_bank_no', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);

    await ctx.reply('⚠️ It seems there was an error. Let\'s try again.');

    // Reset Temp States
    userState.bankName = null;
    userState.bankCode = null;
    userState.accountNumber = null;
    userState.accountName = null;
    userState.awaitingBankName = true;
    userState.awaitingAccountNumber = false;
    await saveUserState(userId); // Save user state

    await ctx.reply('Please enter your bank name:');
  } catch (error) {
    console.error(`Error handling bank confirmation for ${userId}:`, error.message);
    await ctx.reply('❌ An error occurred. Please try linking your bank account again.');
  }
});

// Learn About Base with Pagination
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
    text: 'To start using Base, you can bridge your assets from Ethereum to Base using the official bridge at https://base.org/bridge.',
  },
  {
    title: 'Learn More',
    text: 'Visit the official documentation at https://docs.base.org for in-depth guides and resources.',
  },
];

/**
 * Sends Base content with pagination.
 * @param {Context} ctx
 * @param {number} index
 * @param {boolean} isNewMessage
 */
async function sendBaseContent(ctx, index, isNewMessage = false) {
  const content = baseContent[index];
  const totalPages = baseContent.length;

  const navigationButtons = [];

  if (index > 0) {
    navigationButtons.push(Markup.button.callback('⬅️ Back', `base_page_${index - 1}`));
  }

  if (index < totalPages - 1) {
    navigationButtons.push(Markup.button.callback('Next ➡️', `base_page_${index + 1}`));
  }

  if (isNewMessage) {
    await ctx.replyWithMarkdown(
      `*${content.title}*\n\n${content.text}`,
      Markup.inlineKeyboard(navigationButtons)
    );
  } else {
    try {
      await ctx.editMessageText(
        `*${content.title}*\n\n${content.text}`,
        {
          parse_mode: 'Markdown',
          reply_markup: Markup.inlineKeyboard(navigationButtons).reply_markup,
        }
      );
    } catch (error) {
      console.error('Error editing Base content message:', error.message);
      await ctx.replyWithMarkdown(
        `*${content.title}*\n\n${content.text}`,
        Markup.inlineKeyboard(navigationButtons)
      );
    }
  }
}

// Handle "Learn About Base" Command
bot.hears('📘 Learn About Base', async (ctx) => {
  await sendBaseContent(ctx, 0, true);
});

// Handle Base Content Pagination
bot.action(/base_page_(\d+)/, async (ctx) => {
  const index = parseInt(ctx.match[1], 10);
  await sendBaseContent(ctx, index);
});

// Support Functionality
bot.hears('ℹ️ Support', async (ctx) => {
  try {
    await ctx.reply('How can we assist you today?', Markup.inlineKeyboard([
      [Markup.button.callback('❓ How It Works', 'support_how_it_works')],
      [Markup.button.callback('⚠️ Transaction Not Received', 'support_not_received')],
      [Markup.button.callback('💬 Contact Support', 'support_contact')],
    ]));
  } catch (error) {
    console.error(`Error displaying support options for ${ctx.from.id}:`, error.message);
    await ctx.reply('❌ An error occurred. Please try again later.');
  }
});

// Support Actions
bot.action('support_how_it_works', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.editMessageText('DirectPay allows you to receive crypto payments directly into your bank account seamlessly. Generate a wallet, link your bank, and start receiving payments.');
  } catch (error) {
    console.error('Error editing support "How It Works" message:', error.message);
    await ctx.reply('DirectPay allows you to receive crypto payments directly into your bank account seamlessly. Generate a wallet, link your bank, and start receiving payments.');
  }
});

bot.action('support_not_received', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.editMessageText('If you haven’t received your transaction, please ensure that you have linked your bank account. If the issue persists, contact support.');
  } catch (error) {
    console.error('Error editing support "Transaction Not Received" message:', error.message);
    await ctx.reply('If you haven’t received your transaction, please ensure that you have linked your bank account. If the issue persists, contact support.');
  }
});

bot.action('support_contact', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.editMessageText('You can contact our support team at @your_support_username.');
  } catch (error) {
    console.error('Error editing support "Contact Support" message:', error.message);
    await ctx.reply('You can contact our support team at @your_support_username.');
  }
});

// View Transactions for Users
bot.hears('💰 Transactions', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const transactionsSnapshot = await db.collection('transactions').where('userId', '==', userId).get();

    if (transactionsSnapshot.empty) {
      return ctx.reply('You have no transactions at the moment.');
    }

    let message = '💰 **Your Transactions**:\n\n';

    transactionsSnapshot.forEach((doc) => {
      const tx = doc.data();
      message += `*Reference ID:* ${tx.referenceId}\n`;
      message += `*Amount:* ${tx.amount} ${tx.asset}\n`;
      message += `*Status:* ${tx.status || 'Pending'}\n`;
      message += `*Date:* ${new Date(tx.timestamp).toLocaleString()}\n\n`;
    });

    await ctx.replyWithMarkdown(message);
  } catch (error) {
    console.error(`Error fetching transactions for ${userId}:`, error.message);
    await ctx.reply('❌ Unable to fetch transactions. Please try again later.');
  }
});

// Admin Functions
bot.action(/admin_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();

  if (!isAdmin(userId)) {
    return ctx.reply('⚠️ Unauthorized access.');
  }

  const action = ctx.match[1];
  const userState = await getUserState(userId); // Though admin's state is minimal

  if (action === 'view_transactions') {
    // Fetch and display all transactions
    try {
      const transactionsSnapshot = await db.collection('transactions').get();

      if (transactionsSnapshot.empty) {
        return ctx.reply('No transactions found.');
      }

      let message = '💰 **All Transactions**:\n\n';

      transactionsSnapshot.forEach((doc) => {
        const tx = doc.data();
        message += `*Transaction ID:* ${doc.id}\n`;
        message += `*User ID:* ${tx.userId}\n`;
        message += `*Reference ID:* ${tx.referenceId}\n`;
        message += `*Amount:* ${tx.amount} ${tx.asset}\n`;
        message += `*Status:* ${tx.status || 'Pending'}\n`;
        message += `*Date:* ${new Date(tx.timestamp).toLocaleString()}\n\n`;
      });

      await ctx.replyWithMarkdown(message);
    } catch (error) {
      console.error('Error fetching all transactions:', error.message);
      await ctx.reply('❌ Unable to fetch transactions.');
    }
  } else if (action === 'send_message') {
    // Initiate sending a message to a user
    userState.awaitingUserIdForMessage = true;
    await saveUserState(userId);
    await ctx.reply('🔧 Please enter the User ID you want to message:');
  } else if (action === 'mark_paid') {
    // Admin mark-paid function with transaction selection
    try {
      const pendingTransactionsSnapshot = await db.collection('transactions').where('status', '==', 'Pending').get();
      if (pendingTransactionsSnapshot.empty) {
        return ctx.reply('✅ No pending transactions found.');
      }

      let message = '📝 **Pending Transactions**:\n\n';
      const buttons = [];

      pendingTransactionsSnapshot.forEach((doc) => {
        const tx = doc.data();
        message += `*Transaction ID:* ${doc.id}\n`;
        message += `*User ID:* ${tx.userId}\n`;
        message += `*Reference ID:* ${tx.referenceId}\n`;
        message += `*Amount:* ${tx.amount} ${tx.asset}\n`;
        message += `*Date:* ${new Date(tx.timestamp).toLocaleString()}\n\n`;
        buttons.push([Markup.button.callback(`Mark Paid: ${tx.referenceId}`, `mark_paid_${doc.id}`)]);
      });

      await ctx.replyWithMarkdown(message, Markup.inlineKeyboard(buttons));
    } catch (error) {
      console.error('Error fetching pending transactions for admin:', error.message);
      await ctx.reply('❌ Unable to fetch pending transactions. Please try again later.');
    }
  } else if (action === 'upload_image') {
    // Initiate uploading an image to a user
    userState.awaitingUserIdForImage = true;
    await saveUserState(userId);
    await ctx.reply('🔧 Please enter the User ID you want to send an image to:');
  }
});

// Handle marking a transaction as paid
bot.action(/mark_paid_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();

  if (!isAdmin(userId)) {
    return ctx.reply('⚠️ Unauthorized access.');
  }

  const transactionId = ctx.match[1];

  try {
    const transactionDoc = await db.collection('transactions').doc(transactionId).get();

    if (!transactionDoc.exists) {
      return ctx.reply('❌ Transaction not found.');
    }

    const transactionData = transactionDoc.data();

    // Update transaction status to 'Paid'
    await db.collection('transactions').doc(transactionId).update({ status: 'Paid' });

    // Fetch user data
    const userState = await getUserState(transactionData.userId);

    // Find the wallet associated with the transaction
    const wallet = userState.wallets.find((w) => w.address === transactionData.walletAddress);

    if (!wallet || !wallet.bank) {
      console.error(`Wallet or bank details not found for user ${transactionData.userId}`);
      return ctx.reply('❌ User wallet or bank details not found.');
    }

    // Compose detailed message to send to the user
    const payoutAmount = calculatePayout(transactionData.asset, transactionData.amount);
    const rate = getRate(transactionData.asset);
    const date = new Date().toISOString();
    const message = `Hello ${wallet.bank.accountName},\n\n` +
      `We’ve converted the ${transactionData.amount} ${transactionData.asset} you deposited and successfully sent NGN ${payoutAmount} to your linked account.\n\n` +
      `*Transaction Details*\n` +
      `Crypto Amount:\t${transactionData.amount} ${transactionData.asset}\n` +
      `Cash Amount:\tNGN ${payoutAmount}\n` +
      `Rate:\t${rate} NGN/${transactionData.asset}\n` +
      `Network:\t${transactionData.network || 'Base Network'}\n` +
      `Receiving Account:\t${wallet.bank.bankName.toUpperCase()} ******${wallet.bank.accountNumber.slice(-4)}\n` +
      `Date:\t${date}\n` +
      `Reference:\t${transactionData.referenceId}\n\n` +
      `If you have any questions or need further assistance, please contact us; we’d love to help.`;

    await bot.telegram.sendMessage(transactionData.userId, message, { parse_mode: 'Markdown' });

    // Notify admin
    await ctx.reply('✅ Transaction marked as paid and user notified.');

    // Log to Admin
    await bot.telegram.sendMessage(
      PERSONAL_CHAT_ID,
      `✅ Transaction ${transactionData.referenceId} marked as paid for user ${transactionData.userId} (@${userState.username || 'N/A'}).`
    );
  } catch (error) {
    console.error(`Error marking transaction ${transactionId} as paid:`, error.message);
    await ctx.reply('❌ An error occurred while marking the transaction as paid. Please try again later.');
  }
});

// Handle Admin Image Upload
bot.on('photo', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);

    if (isAdmin(userId) && userState.awaitingImage) {
      const recipientId = userState.imageRecipientId;
      const photo = ctx.message.photo[ctx.message.photo.length - 1]; // Get highest resolution

      try {
        await bot.telegram.sendPhoto(recipientId, photo.file_id);
        await ctx.reply('✅ Image sent successfully.');
        await bot.telegram.sendMessage(
          PERSONAL_CHAT_ID,
          `📸 Admin sent an image to user ${recipientId}.`
        );
      } catch (error) {
        console.error(`Error sending image to user ${recipientId}:`, error.message);
        await ctx.reply('❌ Failed to send image to the user. Please ensure the User ID is correct.');
      }

      // Reset Admin State
      userState.imageRecipientId = null;
      userState.awaitingImage = false;
      await saveUserState(userId); // Save user state
    }
  } catch (error) {
    console.error(`Error handling image upload from admin ${userId}:`, error.message);
    await ctx.reply('❌ An error occurred while processing the image. Please try again.');
  }
});

// Webhook Handler for Deposits
app.post('/webhook/blockradar', async (req, res) => {
  try {
    const event = req.body;

    // Log the received webhook event (optional: remove in production)
    fs.appendFileSync(path.join(__dirname, 'webhook_logs.txt'), `${new Date().toISOString()} - ${JSON.stringify(event, null, 2)}\n`);

    if (event.event === 'deposit.success' || event.event === 'deposit.swept.success') {
      const walletAddress = event.data.address.address;
      const amount = parseFloat(event.data.amount);
      const asset = event.data.asset.symbol;
      const transactionHash = event.data.hash;
      const network = event.data.network || 'Base Network';

      // Find User by Wallet Address
      const walletDoc = await db.collection('walletAddresses').doc(walletAddress).get();

      if (!walletDoc.exists) {
        console.log(`No user found for wallet ${walletAddress}`);
        return res.status(200).send('OK');
      }

      const userId = walletDoc.data().userId;
      const userState = await getUserState(userId);

      const wallet = userState.wallets.find((w) => w.address === walletAddress);

      if (!wallet) {
        console.log(`Wallet ${walletAddress} not found for user ${userId}`);
        return res.status(200).send('OK');
      }

      // Check if Wallet has Linked Bank
      if (!wallet.bank) {
        await bot.telegram.sendMessage(
          userId,
          `💰 Deposit Received: ${amount} ${asset}. Please link a bank account to receive your payout securely.`
        );
        await bot.telegram.sendMessage(
          PERSONAL_CHAT_ID,
          `⚠️ User ${userId} (@${userState.username || 'N/A'}) has received a deposit but hasn't linked a bank account.`
        );
        return res.status(200).send('OK');
      }

      const payout = calculatePayout(asset, amount);
      const referenceId = generateReferenceId();

      // Store Transaction in Firebase
      await db.collection('transactions').add({
        userId,
        walletAddress,
        amount,
        asset,
        transactionHash,
        referenceId,
        bankDetails: wallet.bank,
        network,
        timestamp: new Date().toISOString(),
        status: 'Pending',
      });

      // Notify Admin with Refined Information
      await bot.telegram.sendMessage(
        PERSONAL_CHAT_ID,
        `🔔 Deposit Received:\n\n` +
        `*User ID:* ${userId}\n` +
        `*Username:* @${userState.username || 'N/A'}\n` +
        `*Wallet Address:* ${walletAddress}\n` +
        `*Amount:* ${amount} ${asset}\n` +
        `*Transaction Hash:* ${transactionHash}\n` +
        `*Network:* ${network}\n` +
        `*Bank Name:* ${wallet.bank.bankName}\n` +
        `*Account Number:* ${wallet.bank.accountNumber}\n` +
        `*Account Name:* ${wallet.bank.accountName}\n\n` +
        `Processing NGN ${payout} to their linked bank account.`
      );

      // Notify User of Successful Deposit
      await bot.telegram.sendMessage(
        userId,
        `Hello ${wallet.bank.accountName},\n\n` +
        `We received your deposit of ${amount} ${asset} to your wallet address: \`${walletAddress}\`.\n\n` +
        `Your transaction is being processed. You’ll receive NGN ${payout} in your ${wallet.bank.bankName} account ending with ****${wallet.bank.accountNumber.slice(-4)} shortly.\n\n` +
        `We'll notify you once the process is complete.`,
        { parse_mode: 'Markdown' }
      );

      // Log to Admin
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🗄 Transaction stored in Firebase for user ${userId}.`);

      return res.status(200).send('OK');
    } else {
      // For other events, respond with OK
      return res.status(200).send('OK');
    }
  } catch (error) {
    console.error('Error processing webhook:', error.message);
    res.status(500).send('Error');
    try {
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error processing webhook: ${error.message}`);
    } catch (sendError) {
      console.error('Error sending webhook error message to admin:', sendError.message);
    }
  }
});

// Start Express Server
const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`🚀 Webhook server running on port ${port}`);
});

// Launch Bot
bot.launch({
  dropPendingUpdates: true, // Optional: Drop pending updates on restart
})
  .then(() => console.log('🤖 DirectPay bot is live!'))
  .catch((err) => {
    console.error('❌ Error launching bot:', err.message);
    process.exit(1); // Exit if bot fails to launch
  });

// Graceful Shutdown
process.once('SIGINT', () => {
  console.log('🔄 Received SIGINT. Shutting down gracefully...');
  bot.stop('SIGINT');
  process.exit(0);
});
process.once('SIGTERM', () => {
  console.log('🔄 Received SIGTERM. Shutting down gracefully...');
  bot.stop('SIGTERM');
  process.exit(0);
});
