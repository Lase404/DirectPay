require('dotenv').config();
const express = require('express');
const { Telegraf, Markup, Scenes, session } = require('telegraf');
const axios = require('axios');
const admin = require('firebase-admin');
const winston = require('winston');
const crypto = require('crypto');
const Bottleneck = require('bottleneck'); // For rate limiting
const fs = require('fs');
const path = require('path');

// =================== Firebase Admin Initialization ===================

admin.initializeApp({
  credential: admin.credential.cert(require('./serviceAccountKey.json')),
});
const db = admin.firestore();

// =================== Logger Setup ===================

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(
      ({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}]: ${message}`
    )
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'bot.log' }),
  ],
});

// =================== Telegraf Bot Initialization ===================

const BOT_TOKEN = process.env.BOT_TOKEN;
const PERSONAL_CHAT_ID = process.env.PERSONAL_CHAT_ID; // Admin Chat ID
const TELEGRAM_WEBHOOK_URL = process.env.TELEGRAM_WEBHOOK_URL;
const TELEGRAM_WEBHOOK_PATH = process.env.TELEGRAM_WEBHOOK_PATH || '/webhook/telegram';
const MAX_WALLETS = parseInt(process.env.MAX_WALLETS, 10) || 5;

if (!BOT_TOKEN || !PERSONAL_CHAT_ID || !TELEGRAM_WEBHOOK_URL) {
  logger.error('One or more required environment variables are missing.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// =================== Middleware ===================

bot.use(session());

// =================== Helper Functions ===================

/**
 * Generates a unique reference ID.
 */
function generateReferenceId() {
  return crypto.randomBytes(8).toString('hex').toUpperCase();
}

/**
 * Calculates the payout in NGN based on asset and amount.
 * Assumes exchangeRates is an object with asset symbols as keys.
 */
function calculatePayout(asset, amount, exchangeRates) {
  const rate = exchangeRates[asset];
  if (!rate) throw new Error(`Exchange rate for ${asset} not found.`);
  return rate * amount;
}

/**
 * Placeholder function to generate a wallet address.
 * Replace with actual wallet generation logic.
 */
async function generateWallet(chain) {
  // Implement your wallet generation logic here
  // For demonstration, return a dummy address
  return `0x${crypto.randomBytes(20).toString('hex')}`;
}

/**
 * Retrieves user state from Firestore.
 */
async function getUserState(userId) {
  const userDoc = await db.collection('users').doc(userId).get();
  if (!userDoc.exists) {
    // Initialize user state if not present
    await db.collection('users').doc(userId).set({
      wallets: [],
      walletAddresses: [],
      firstName: '', // Add other default fields as needed
    });
    return { wallets: [], walletAddresses: [], firstName: '' };
  }
  return userDoc.data();
}

/**
 * Updates user state in Firestore.
 */
async function updateUserState(userId, data) {
  await db.collection('users').doc(userId).update(data);
}

/**
 * Placeholder function to verify bank account.
 * Replace with actual verification logic.
 */
async function verifyBankAccount(accountNumber, bankCode) {
  // Implement your bank account verification logic here
  // For demonstration, return a dummy account name
  return { data: { account_name: 'John Doe' } };
}

/**
 * Placeholder function to create a Paycrest order.
 * Replace with actual Paycrest API integration.
 */
async function createPaycrestOrder(userId, amount, asset, chain, bankDetails) {
  // Implement your Paycrest order creation logic here
  // For demonstration, return a dummy order
  return { id: `PAYCREST_${crypto.randomBytes(6).toString('hex').toUpperCase()}`, receiveAddress: '0xPaycrestReceiveAddress' };
}

/**
 * Placeholder function to withdraw from Blockradar.
 * Replace with actual Blockradar API integration.
 */
async function withdrawFromBlockradar(chain, assetId, receiveAddress, amount, paycrestOrderId, metadata) {
  // Implement your Blockradar withdrawal logic here
  // For demonstration, simulate a successful withdrawal
  logger.info(`Withdrawing ${amount} from Blockradar on ${chain} to ${receiveAddress} for Order ID ${paycrestOrderId}`);
  // Throw an error to simulate failure if needed
  // throw new Error('Blockradar withdrawal failed.');
}

// =================== Exchange Rates ===================

// Example exchange rates; in practice, fetch dynamically
const exchangeRates = {
  USDC: 500, // 1 USDC = 500 NGN
  USDT: 495, // 1 USDT = 495 NGN
};

// =================== Chain Mapping ===================

const chainMapping = {
  'base': 'Base',
  'polygon': 'Polygon',
  'bnb smart chain': 'BNB Smart Chain',
};

// =================== Scenes Definitions ===================

const bankLinkingScene = new Scenes.BaseScene('bank_linking_scene');

bankLinkingScene.enter(async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = ctx.session.walletIndex;

  if (walletIndex === undefined || walletIndex === null) {
    await ctx.replyWithMarkdown('⚠️ No wallet selected for linking. Please generate a wallet first.');
    ctx.scene.leave();
    return;
  }

  ctx.session.isBankLinking = true;
  ctx.session.bankData = {};
  ctx.session.bankData.step = 1;
  await ctx.replyWithMarkdown('🏦 Please enter your bank name (e.g., Access Bank):');

  // Start the inactivity timeout
  ctx.session.bankLinkingTimeout = setTimeout(() => {
    if (ctx.session.isBankLinking) {
      ctx.replyWithMarkdown('⏰ Bank linking process timed out due to inactivity. Please start again if you wish to link a bank account.');
      ctx.scene.leave();
    }
  }, 300000); // 5 minutes timeout
});

bankLinkingScene.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const input = ctx.message.text.trim();

  // Clear the inactivity timeout upon receiving input
  if (ctx.session.bankLinkingTimeout) {
    clearTimeout(ctx.session.bankLinkingTimeout);
  }

  if (ctx.session.bankData.step === 1) {
    // Step 1: Process Bank Name
    const bankNameInput = input.toLowerCase();
    const bankList = [
      { name: 'Access Bank', aliases: ['access bank', 'access'] },
      { name: 'GTBank', aliases: ['gtbank', 'gt bank'] },
      // Add other supported banks here
    ];
    const bank = bankList.find((b) => b.aliases.includes(bankNameInput));

    if (!bank) {
      return await ctx.replyWithMarkdown(
        '❌ Invalid bank name. Please enter a valid bank name from our supported list:\n\n' +
        bankList.map(b => `• ${b.name}`).join('\n')
      );
    }

    ctx.session.bankData.bankName = bank.name;
    ctx.session.bankData.bankCode = 'BANKCODE'; // Replace with actual bank code if needed
    ctx.session.bankData.step = 2;

    await ctx.replyWithMarkdown('🔢 Please enter your 10-digit bank account number:');

    // Restart the inactivity timeout
    ctx.session.bankLinkingTimeout = setTimeout(() => {
      if (ctx.session.isBankLinking) {
        ctx.replyWithMarkdown('⏰ Bank linking process timed out due to inactivity. Please start again if you wish to link a bank account.');
        ctx.scene.leave();
      }
    }, 300000); // 5 minutes timeout
  } else if (ctx.session.bankData.step === 2) {
    // Step 2: Process Account Number
    if (!/^\d{10}$/.test(input)) {
      return await ctx.replyWithMarkdown('❌ Invalid account number. Please enter a valid 10-digit account number:');
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

      // Restart the inactivity timeout
      ctx.session.bankLinkingTimeout = setTimeout(() => {
        if (ctx.session.isBankLinking) {
          ctx.replyWithMarkdown('⏰ Bank linking process timed out due to inactivity. Please start again if you wish to link a bank account.');
          ctx.scene.leave();
        }
      }, 300000); // 5 minutes timeout
    } catch (error) {
      logger.error(`Error verifying bank account for user ${userId}: ${error.message}`);
      await ctx.replyWithMarkdown('❌ Failed to verify your bank account. Please ensure your details are correct or try again later.');
      ctx.scene.leave();
    }
  }
});

// Confirm Bank Account
bankLinkingScene.action('confirm_bank_yes', async (ctx) => {
  const userId = ctx.from.id.toString();
  const bankData = ctx.session.bankData;
  const walletIndex = ctx.session.walletIndex;

  try {
    let userState = await getUserState(userId);

    if (walletIndex === undefined || walletIndex === null || !userState.wallets[walletIndex]) {
      await ctx.replyWithMarkdown('⚠️ No wallet selected for linking. Please generate a wallet first.');
      ctx.scene.leave();
      return;
    }

    // Update Bank Details for the Selected Wallet
    userState.wallets[walletIndex].bank = {
      bankName: bankData.bankName,
      bankCode: bankData.bankCode,
      accountNumber: bankData.accountNumber,
      accountName: bankData.accountName,
    };

    // Update User State in Firestore
    await updateUserState(userId, {
      wallets: userState.wallets,
    });

    // Prepare Confirmation Message with Wallet Details
    let confirmationMessage = `✅ *Bank Account Linked Successfully!*\n\n`;
    confirmationMessage += `*Bank Name:* ${bankData.bankName}\n`;
    confirmationMessage += `*Account Number:* ****${bankData.accountNumber.slice(-4)}\n`;
    confirmationMessage += `*Account Holder:* ${bankData.accountName}\n\n`;
    confirmationMessage += `📂 *Linked Wallet Details:*\n`;
    confirmationMessage += `• *Chain:* ${userState.wallets[walletIndex].chain}\n`;
    confirmationMessage += `• *Address:* \`${userState.wallets[walletIndex].address}\`\n\n`;
    confirmationMessage += `You can now receive payouts to this bank account.`;

    await ctx.replyWithMarkdown(confirmationMessage, getMainMenu(true, true));

    // Log to Admin
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🔗 User ${userId} linked a bank account:\n\n` +
      `*Account Name:* ${userState.wallets[walletIndex].bank.accountName}\n` +
      `*Bank Name:* ${userState.wallets[walletIndex].bank.bankName}\n` +
      `*Account Number:* ****${userState.wallets[walletIndex].bank.accountNumber.slice(-4)}`, { parse_mode: 'Markdown' });
    logger.info(`User ${userId} linked a bank account: ${JSON.stringify(userState.wallets[walletIndex].bank)}`);

    // Acknowledge the Callback to Remove Loading State
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in confirm_bank_yes handler for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('❌ An error occurred while confirming your bank details. Please try again later.');
    ctx.scene.leave();
  }
});

// Decline Bank Account Confirmation
bankLinkingScene.action('confirm_bank_no', async (ctx) => {
  await ctx.replyWithMarkdown('⚠️ Let\'s try again.');

  // Reset Bank Data and Restart the Scene
  ctx.session.bankData = {};
  ctx.session.bankData.step = 1;

  // Restart the inactivity timeout
  if (ctx.session.bankLinkingTimeout) {
    clearTimeout(ctx.session.bankLinkingTimeout);
  }
  ctx.session.bankLinkingTimeout = setTimeout(() => {
    if (ctx.session.isBankLinking) {
      ctx.replyWithMarkdown('⏰ Bank linking process timed out due to inactivity. Please start again if you wish to link a bank account.');
      ctx.scene.leave();
    }
  }, 300000); // 5 minutes timeout

  ctx.scene.reenter(); // Restart the scene
});

// Handle Cancellation of Bank Linking
bankLinkingScene.action('cancel_bank_linking', async (ctx) => {
  await ctx.replyWithMarkdown('❌ Bank linking process has been canceled.');

  // Clean Up Session Variables
  delete ctx.session.walletIndex;
  delete ctx.session.bankData;
  delete ctx.session.processType;
  delete ctx.session.isBankLinking; // Ensure flag is reset

  // Clear the inactivity timeout
  if (ctx.session.bankLinkingTimeout) {
    clearTimeout(ctx.session.bankLinkingTimeout);
    delete ctx.session.bankLinkingTimeout;
  }

  ctx.scene.leave();
});

// =================== Send Message Scene ===================

const sendMessageScene = new Scenes.BaseScene('send_message_scene');

sendMessageScene.enter(async (ctx) => {
  await ctx.replyWithMarkdown('📩 Please enter the User ID you want to message:');
});

sendMessageScene.on('message', async (ctx) => {
  const userId = ctx.from.id.toString();
  let userState;
  try {
    userState = await getUserState(userId);
  } catch (error) {
    logger.error(`Error fetching user state for ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
    return;
  }

  if (!ctx.session.sendMessageStep) {
    // Step 1: Capture User ID
    const userIdToMessage = ctx.message.text.trim();

    // Validate User ID (should be numeric and reasonable length, e.g., Telegram IDs are typically between 5 to 15 digits)
    if (!/^\d{5,15}$/.test(userIdToMessage)) {
      return ctx.replyWithMarkdown('❌ Invalid User ID. Please enter a valid numeric User ID (5-15 digits):');
    }

    // Optionally, verify if the User ID exists in your database
    const userDoc = await db.collection('users').doc(userIdToMessage).get();
    if (!userDoc.exists) {
      return ctx.replyWithMarkdown('❌ User ID not found. Please ensure the User ID is correct or try another one:');
    }

    // Proceed to Step 2
    ctx.session.sendMessageStep = 2;
    ctx.session.userIdToMessage = userIdToMessage;
    await ctx.replyWithMarkdown('📝 Please enter the message you want to send to the user. You can also attach an image (receipt) with your message.');
  } else if (ctx.session.sendMessageStep === 2) {
    // Step 2: Capture Message Content
    const userIdToMessage = ctx.session.userIdToMessage;

    if (ctx.message.photo) {
      // Message contains a photo
      const photoArray = ctx.message.photo;
      const highestResolutionPhoto = photoArray[photoArray.length - 1]; // Get the highest resolution photo
      const fileId = highestResolutionPhoto.file_id;
      const caption = ctx.message.caption || '';

      try {
        // Send the photo with caption to the target user
        await bot.telegram.sendPhoto(userIdToMessage, fileId, { caption: caption, parse_mode: 'Markdown' });
        await ctx.replyWithMarkdown('✅ Photo message sent successfully.');
        logger.info(`Admin ${userId} sent photo message to user ${userIdToMessage}. Caption: ${caption}`);
      } catch (error) {
        logger.error(`Error sending photo to user ${userIdToMessage}: ${error.message}`);
        await ctx.replyWithMarkdown('⚠️ Error sending photo. Please ensure the User ID is correct and the user has not blocked the bot.');
      }
    } else if (ctx.message.text) {
      // Message contains only text
      const messageContent = ctx.message.text.trim();

      if (!messageContent) {
        return ctx.reply('❌ Message content cannot be empty. Please enter a valid message:');
      }

      try {
        // Send the text message to the target user
        await bot.telegram.sendMessage(userIdToMessage, `**📩 Message from Admin:**\n\n${messageContent}`, { parse_mode: 'Markdown' });
        await ctx.replyWithMarkdown('✅ Text message sent successfully.');
        logger.info(`Admin ${userId} sent text message to user ${userIdToMessage}: ${messageContent}`);
      } catch (error) {
        logger.error(`Error sending message to user ${userIdToMessage}: ${error.message}`);
        await ctx.replyWithMarkdown('⚠️ Error sending message. Please ensure the User ID is correct and the user has not blocked the bot.');
      }
    } else {
      // Unsupported message type
      await ctx.reply('❌ Unsupported message type. Please send text or a photo (receipt).');
      return;
    }

    // Reset Session Variables and Leave the Scene
    delete ctx.session.userIdToMessage;
    delete ctx.session.sendMessageStep;
    ctx.scene.leave();
  }
});

// Handle Unsupported Message Types in SendMessageScene
sendMessageScene.on('message', async (ctx) => {
  if (ctx.session.sendMessageStep !== undefined) {
    await ctx.reply('❌ Please send text messages or photos only.');
  }
});

// Handle Scene Exit
sendMessageScene.leave((ctx) => {
  delete ctx.session.userIdToMessage;
  delete ctx.session.sendMessageStep;
});

// =================== Scenes Stage ===================

const stage = new Scenes.Stage([bankLinkingScene, sendMessageScene]);
bot.use(stage.middleware());

// =================== Inline Menu Functions ===================

/**
 * Returns the main menu keyboard.
 * @param {boolean} hasBank Linked bank status
 * @param {boolean} hasWallets Whether the user has wallets
 */
function getMainMenu(hasBank = false, hasWallets = false) {
  return Markup.keyboard([
    ['💼 Generate Wallet', '💰 Transactions'],
    ['🏦 Link Bank Account', '📈 View Rates'],
    ['ℹ️ Support', '⚙️ Settings'],
  ]).resize();
}

/**
 * Returns the settings menu keyboard.
 */
function getSettingsMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Generate New Wallet', 'settings_generate_wallet')],
    [Markup.button.callback('✏️ Edit Linked Bank Details', 'settings_edit_bank')],
    [Markup.button.callback('💬 Support', 'settings_support')],
    [Markup.button.callback('🧾 Generate Transaction Receipt', 'settings_generate_receipt')],
    [Markup.button.callback('🔄 Refresh Wallets', 'settings_refresh_wallets')],
    [Markup.button.callback('🔙 Back to Main Menu', 'settings_back_main')],
  ]);
}

/**
 * Returns the admin menu keyboard.
 */
function getAdminMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📊 View Transactions', 'admin_view_transactions')],
    [Markup.button.callback('📣 Broadcast Message', 'admin_send_message')],
    [Markup.button.callback('✅ Mark Pending as Paid', 'admin_mark_paid')],
    [Markup.button.callback('👥 View Users', 'admin_view_users')],
    [Markup.button.callback('🔙 Back to Main Menu', 'admin_back_to_main')],
  ]);
}

/**
 * Sends the main menu to the user.
 */
async function greetUser(ctx) {
  const userId = ctx.from.id.toString();
  let userState;
  try {
    userState = await getUserState(userId);
  } catch (error) {
    logger.error(`Error fetching user state for ${userId}: ${error.message}`);
    await ctx.reply('⚠️ An error occurred. Please try again later.');
    return;
  }

  // Optionally, update the user's first name or other details
  if (!userState.firstName) {
    await updateUserState(userId, { firstName: ctx.from.first_name || '' });
  }

  await ctx.reply('👋 Welcome to *DirectPay*! Please choose an option below:', getMainMenu(userState.wallets.some(w => w.bank), userState.wallets.length > 0));
}

// =================== Handle "💼 Generate Wallet" Button ===================

bot.hears('💼 Generate Wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);

    if (userState.wallets.length >= MAX_WALLETS) {
      return ctx.replyWithMarkdown(`⚠️ You cannot generate more than ${MAX_WALLETS} wallets.`);
    }

    // Prompt the user to select a network for the new wallet
    await ctx.reply('📂 *Select the network for your new wallet:*', Markup.inlineKeyboard([
      [Markup.button.callback('Base', 'generate_wallet_Base')],
      [Markup.button.callback('Polygon', 'generate_wallet_Polygon')],
      [Markup.button.callback('BNB Smart Chain', 'generate_wallet_BNB Smart Chain')],
    ]));
  } catch (error) {
    logger.error(`Error initiating wallet generation for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while initiating wallet generation. Please try again later.');
  }
});

// =================== Handle Wallet Generation Actions ===================

bot.action(/generate_wallet_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const chain = ctx.match[1];

  // Acknowledge the callback to remove the loading state
  await ctx.answerCbQuery(`Generating wallet for ${chain}... Please wait a moment.`);

  try {
    const walletAddress = await generateWallet(chain);

    // Fetch Updated User State
    const userState = await getUserState(userId);

    if (userState.wallets.length >= MAX_WALLETS) {
      await ctx.replyWithMarkdown(`⚠️ You cannot generate more than ${MAX_WALLETS} wallets.`);
      await ctx.deleteMessage(ctx.message.message_id);
      return;
    }

    // Add the New Wallet to User State
    userState.wallets.push({
      address: walletAddress || 'N/A',
      chain: chain || 'N/A',
      supportedAssets: ['USDC', 'USDT'], // Example supported assets
      bank: null,
      amount: 0, // Initialize amount if needed
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
    await ctx.deleteMessage(ctx.message.message_id);

    // Enter the Bank Linking Scene Immediately
    await ctx.scene.enter('bank_linking_scene');
  } catch (error) {
    logger.error(`Error generating wallet for user ${userId} on ${chain}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ There was an issue generating your wallet. Please try again later.');
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error generating wallet for user ${userId}: ${error.message}`, { parse_mode: 'Markdown' });
  }
});

// =================== Handle "💼 View Wallet" Button ===================

bot.hears('💼 View Wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);

    if (userState.wallets.length === 0) {
      return ctx.replyWithMarkdown('❌ You have no wallets. Please generate a wallet first using the "💼 Generate Wallet" option.');
    }

    let message = '💼 *Your Wallets*:\n\n';
    userState.wallets.forEach((wallet, index) => {
      message += `*Wallet ${index + 1}:*\n`;
      message += `• *Chain:* ${wallet.chain}\n`;
      message += `• *Address:* \`${wallet.address}\`\n`;
      message += `• *Bank Linked:* ${wallet.bank ? '✅ Yes' : '❌ No'}\n\n`;
    });

    // Add an inline button to generate a new wallet
    const inlineKeyboard = Markup.inlineKeyboard([
      [Markup.button.callback('➕ Generate New Wallet', 'view_wallet_generate_new')],
      [Markup.button.callback('🔙 Back to Main Menu', 'back_to_main')]
    ]);

    await ctx.replyWithMarkdown(message, inlineKeyboard);
  } catch (error) {
    logger.error(`Error handling View Wallet for user ${userId}: ${error.message}`);
    await ctx.reply('⚠️ An error occurred while fetching your wallets. Please try again later.');
  }
});

// Handle "Generate New Wallet" from View Wallet Inline Button
bot.action('view_wallet_generate_new', async (ctx) => {
  const userId = ctx.from.id.toString();

  // Acknowledge the callback to remove the loading state
  await ctx.answerCbQuery();

  try {
    const userState = await getUserState(userId);

    if (userState.wallets.length >= MAX_WALLETS) {
      return ctx.replyWithMarkdown(`⚠️ You have reached the maximum number of wallets (${MAX_WALLETS}). Please manage your existing wallets before adding new ones.`);
    }

    // Prompt the user to select a network for the new wallet
    await ctx.reply('📂 *Select the network for the new wallet:*', Markup.inlineKeyboard([
      [Markup.button.callback('Base', 'generate_wallet_Base')],
      [Markup.button.callback('Polygon', 'generate_wallet_Polygon')],
      [Markup.button.callback('BNB Smart Chain', 'generate_wallet_BNB Smart Chain')],
    ]));

  } catch (error) {
    logger.error(`Error initiating wallet generation from View Wallet for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while initiating wallet generation. Please try again later.');
  }
});

// Handle "Back to Main Menu" from View Wallet Inline Button
bot.action('back_to_main', async (ctx) => {
  await greetUser(ctx); // Reuse the greetUser function to display the main menu
  ctx.answerCbQuery();
});

// =================== Handle "⚙️ Settings" Button ===================

bot.hears('⚙️ Settings', async (ctx) => {
  await ctx.reply('⚙️ *Settings Menu*', getSettingsMenu());
});

// Handle "Generate New Wallet" from Settings Inline Button
bot.action('settings_generate_wallet', async (ctx) => {
  const userId = ctx.from.id.toString();

  // Acknowledge the callback to remove the loading state
  await ctx.answerCbQuery();

  try {
    const userState = await getUserState(userId);

    if (userState.wallets.length >= MAX_WALLETS) {
      return ctx.replyWithMarkdown(`⚠️ You have reached the maximum number of wallets (${MAX_WALLETS}). Please manage your existing wallets before adding new ones.`);
    }

    // Prompt the user to select a network for the new wallet
    await ctx.reply('📂 *Select the network for your new wallet:*', Markup.inlineKeyboard([
      [Markup.button.callback('Base', 'generate_wallet_Base')],
      [Markup.button.callback('Polygon', 'generate_wallet_Polygon')],
      [Markup.button.callback('BNB Smart Chain', 'generate_wallet_BNB Smart Chain')],
    ]));

  } catch (error) {
    logger.error(`Error initiating wallet generation from Settings for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while initiating wallet generation. Please try again later.');
  }
});

// Handle "Refresh Wallets" from Settings Inline Button
bot.action('settings_refresh_wallets', async (ctx) => {
  const userId = ctx.from.id.toString();

  // Acknowledge the callback to remove the loading state
  await ctx.answerCbQuery();

  try {
    const userState = await getUserState(userId);

    if (userState.wallets.length === 0) {
      return ctx.replyWithMarkdown('❌ You have no wallets. Please generate a wallet first using the "💼 Generate Wallet" option.');
    }

    let message = '💼 *Your Wallets*:\n\n';
    userState.wallets.forEach((wallet, index) => {
      message += `*Wallet ${index + 1}:*\n`;
      message += `• *Chain:* ${wallet.chain}\n`;
      message += `• *Address:* \`${wallet.address}\`\n`;
      message += `• *Bank Linked:* ${wallet.bank ? '✅ Yes' : '❌ No'}\n\n`;
    });

    // Add an inline button to generate a new wallet
    const inlineKeyboard = Markup.inlineKeyboard([
      [Markup.button.callback('➕ Generate New Wallet', 'view_wallet_generate_new')],
      [Markup.button.callback('🔙 Back to Settings Menu', 'settings_back_main')]
    ]);

    await ctx.replyWithMarkdown(message, inlineKeyboard);

  } catch (error) {
    logger.error(`Error refreshing wallets from Settings for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while refreshing your wallets. Please try again later.');
  }
});

// Handle "Edit Linked Bank Details" from Settings Inline Button
bot.action('settings_edit_bank', async (ctx) => {
  const userId = ctx.from.id.toString();

  // Acknowledge the callback to remove the loading state
  await ctx.answerCbQuery();

  try {
    const userState = await getUserState(userId);

    if (userState.wallets.length === 0) {
      return ctx.replyWithMarkdown('❌ You have no wallets to edit. Please generate a wallet first using the "💼 Generate Wallet" option.');
    }

    // If multiple wallets, prompt user to select which wallet to edit
    if (userState.wallets.length > 1) {
      let keyboard = userState.wallets.map((wallet, index) => [
        Markup.button.callback(`Wallet ${index + 1} - ${wallet.chain}`, `select_wallet_edit_bank_${index}`)
      ]);
      await ctx.reply('Please select the wallet for which you want to edit the bank details:', Markup.inlineKeyboard(keyboard));
    } else {
      // Only one wallet, proceed to edit bank details
      ctx.session.walletIndex = 0;
      await ctx.scene.enter('bank_linking_scene');
    }

  } catch (error) {
    logger.error(`Error handling Edit Bank Details from Settings for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while editing your bank details. Please try again later.');
  }
});

// Handle "Support" from Settings Inline Button
bot.action('settings_support', async (ctx) => {
  await ctx.replyWithMarkdown('🛠️ *Support Section*\n\nSelect an option below:', Markup.inlineKeyboard([
    [Markup.button.callback('❓ How It Works', 'support_how_it_works')],
    [Markup.button.callback('⚠️ Transaction Not Received', 'support_not_received')],
    [Markup.button.callback('💬 Contact Support', 'support_contact')],
  ]));

  // Acknowledge the callback
  await ctx.answerCbQuery();
});

// Handle "Generate Transaction Receipt" from Settings Inline Button
bot.action('settings_generate_receipt', async (ctx) => {
  const userId = ctx.from.id.toString();

  // Acknowledge the callback to remove the loading state
  await ctx.answerCbQuery();

  try {
    const userState = await getUserState(userId);

    if (userState.wallets.length === 0) {
      return ctx.replyWithMarkdown('❌ You have no transactions to generate receipts for.');
    }

    // Fetch the latest transactions
    const transactionsSnapshot = await db.collection('transactions').where('userId', '==', userId).orderBy('timestamp', 'desc').limit(5).get();

    if (transactionsSnapshot.empty) {
      return ctx.replyWithMarkdown('❌ You have no recent transactions to generate receipts for.');
    }

    let message = '🧾 *Recent Transaction Receipts*:\n\n';

    transactionsSnapshot.forEach((doc) => {
      const tx = doc.data();
      message += `*Reference ID:* \`${tx.referenceId || 'N/A'}\`\n`;
      message += `*Amount:* ${tx.amount || 'N/A'} ${tx.asset || 'N/A'}\n`;
      message += `*Status:* ${tx.status || 'Pending'}\n`;
      message += `*Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n`;
      message += `*Chain:* ${tx.chain || 'N/A'}\n\n`;
    });

    await ctx.replyWithMarkdown(message);

  } catch (error) {
    logger.error(`Error generating transaction receipts for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while generating your receipts. Please try again later.');
  }
});

// Handle "Back to Settings Menu" from Settings Submenu
bot.action('settings_back_main', async (ctx) => {
  await ctx.reply('⚙️ *Settings Menu*', getSettingsMenu());
  ctx.answerCbQuery();
});

// Handle Selecting Wallet to Edit Bank Details
bot.action(/select_wallet_edit_bank_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);

  if (isNaN(walletIndex)) {
    await ctx.replyWithMarkdown('⚠️ Invalid wallet selection. Please try again.');
    return ctx.answerCbQuery();
  }

  // Acknowledge the callback
  await ctx.answerCbQuery();

  // Set the selected wallet index in session
  ctx.session.walletIndex = walletIndex;

  // Enter the Bank Linking Scene to edit bank details
  await ctx.scene.enter('bank_linking_scene');
});

// =================== Support Actions ===================

const detailedTutorials = {
  how_it_works: `
**📘 How DirectPay Works**

1. **Generate Your Wallet:**
   - Navigate to the "💼 Generate Wallet" option.
   - Select your preferred network (Base, Polygon, BNB Smart Chain).
   - Receive a unique wallet address where you can receive crypto payments.

2. **Link Your Bank Account:**
   - Go to "⚙️ Settings" > "🏦 Link Bank Account."
   - Provide your bank details to securely receive payouts directly into your bank account.

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
**🏦 How to Link or Edit Your Bank Account**

*Linking a New Bank Account:*

1. **Navigate to Bank Linking:**
   - Click on "⚙️ Settings" > "🏦 Link Bank Account" from the main menu.

2. **Select Your Wallet:**
   - If you have multiple wallets, select the one you want to link a bank account to.

3. **Provide Bank Details:**
   - Enter your bank name (e.g., Access Bank).
   - Input your 10-digit bank account number.

4. **Verify Account:**
   - DirectPay will verify your bank account details.
   - Confirm the displayed account holder name.

5. **Completion:**
   - Once verified, your bank account is linked and ready to receive payouts.

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

// =================== Support Actions Handlers ===================

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

// =================== Admin Functions ===================

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

  // No cron job setup; admin panel message will persist until manually deleted or a timeout is implemented
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
          message += `*Amount:* ${tx.amount || 'N/A'} ${tx.asset || 'N/A'}\n`;
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
      if (ctx.session.adminMessageId) {
        await ctx.deleteMessage(ctx.session.adminMessageId).catch(() => {});
        ctx.session.adminMessageId = null;
      }
      await ctx.scene.enter('send_message_scene');
      ctx.answerCbQuery();
      break;

    case 'mark_paid':
      // Handle marking transactions as paid as a backup
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
              `*Reference ID:* \`${txData.referenceId}\`\n` +
              `*Amount Paid:* ${txData.amount} ${txData.asset}\n` +
              `*Bank:* ${txData.bankDetails.bankName || 'N/A'}\n` +
              `*Account Name:* ${accountName}\n` +
              `*Account Number:* ****${txData.bankDetails.accountNumber.slice(-4)}\n` +
              `*Payout (NGN):* ₦${payout}\n\n` +
              `🔹 *Chain:* ${txData.chain}\n` +
              `*Date:* ${new Date(txData.timestamp).toLocaleString()}\n\n` +
              `Thank you for using *DirectPay*! Your funds have been securely transferred to your bank account. If you have any questions or need further assistance, feel free to [contact our support team](https://t.me/maxcswap).`,
              { parse_mode: 'Markdown' }
            );
            logger.info(`Notified user ${txData.userId} about paid transaction ${txData.referenceId}`);
          } catch (error) {
            logger.error(`Error notifying user ${txData.userId}: ${error.message}`);
          }
        });

        // Edit the admin panel message to confirm
        await ctx.editMessageText('✅ All pending transactions have been marked as paid.', { reply_markup: getAdminMenu().reply_markup });
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

        // Add a 'Back' button to return to the admin menu
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

// =================== Admin Verification Function ===================

/**
 * Checks if the user is an admin.
 * Replace the logic as per your admin management strategy.
 */
function isAdmin(userId) {
  const adminIds = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',') : [];
  return adminIds.includes(userId);
}

// =================== Handle "📈 View Current Rates" Button ===================

bot.hears('📈 View Current Rates', async (ctx) => {
  try {
    let message = '📈 *Current Exchange Rates*:\n\n';
    for (const [asset, rate] of Object.entries(exchangeRates)) {
      message += `• *${asset}*: ₦${rate}\n`;
    }
    // Add a refresh button
    message += `\nTo refresh the rates, press the "🔄 Refresh Rates" button below.`;
    await ctx.replyWithMarkdown(message, Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Refresh Rates', 'refresh_rates')]
    ]));
  } catch (error) {
    logger.error(`Error fetching exchange rates for user ${ctx.from.id}: ${error.message}`);
    await ctx.reply('⚠️ Unable to fetch exchange rates at the moment. Please try again later.');
  }
});

// Handle "🔄 Refresh Rates" Button
bot.action('refresh_rates', async (ctx) => {
  try {
    // Here, you should implement the logic to fetch the latest exchange rates.
    // For demonstration, we'll assume exchangeRates are updated externally.
    let message = '🔄 *Exchange Rates Refreshed*:\n\n';
    for (const [asset, rate] of Object.entries(exchangeRates)) {
      message += `• *${asset}*: ₦${rate}\n`;
    }
    message += `\n*Latest Rates:* Updated just now.`;
    await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Refresh Rates', 'refresh_rates')]
    ]).reply_markup });
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error refreshing exchange rates: ${error.message}`);
    await ctx.reply('⚠️ Unable to refresh exchange rates at the moment. Please try again later.');
    ctx.answerCbQuery();
  }
});

// =================== Handle "💰 Transactions" Button ===================

bot.hears(/💰\s*Transactions/i, async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const transactionsSnapshot = await db.collection('transactions').where('userId', '==', userId).orderBy('timestamp', 'desc').get();

    if (transactionsSnapshot.empty) {
      return await ctx.replyWithMarkdown('You have no transactions at the moment.');
    }

    let message = '💰 *Your Transactions*:\n\n';

    transactionsSnapshot.forEach((doc) => {
      const tx = doc.data();
      message += `*Reference ID:* \`${tx.referenceId || 'N/A'}\`\n`;
      message += `*Amount:* ${tx.amount || 'N/A'} ${tx.asset || 'N/A'}\n`;
      message += `*Status:* ${tx.status || 'Pending'}\n`;
      message += `*Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n`;
      message += `*Chain:* ${tx.chain || 'N/A'}\n\n`;
    });

    await ctx.replyWithMarkdown(message);
  } catch (error) {
    logger.error(`Error fetching transactions for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ Unable to fetch transactions. Please try again later.');
  }
});

// =================== Support Functionality ===================

bot.hears(/ℹ️\s*Support/i, async (ctx) => {
  await ctx.replyWithMarkdown('🛠️ *Support Section*\n\nSelect an option below:', Markup.inlineKeyboard([
    [Markup.button.callback('❓ How It Works', 'support_how_it_works')],
    [Markup.button.callback('⚠️ Transaction Not Received', 'support_not_received')],
    [Markup.button.callback('💬 Contact Support', 'support_contact')],
  ]));
});

// =================== Handle "📘 Learn About Base" with Pagination ===================

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

// Start the "Learn About Base" Section
bot.hears(/📘\s*Learn About Base/i, async (ctx) => {
  await sendBaseContent(ctx, 0, true);
});

// Function to Send Base Content with Pagination and Inline Updates
async function sendBaseContent(ctx, index, isNew = false) {
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

  // Optionally, implement a timeout to delete the message after a certain period
  // setTimeout(() => {
  //   if (ctx.session.baseMessageId) {
  //     ctx.deleteMessage(ctx.session.baseMessageId).catch(() => {});
  //     ctx.session.baseMessageId = null;
  //   }
  // }, 120000); // Delete after 2 minutes
}

// Handle Base Content Pagination
bot.action(/base_page_(\d+)/, async (ctx) => {
  const index = parseInt(ctx.match[1], 10);
  if (isNaN(index) || index < 0 || index >= baseContent.length) {
    return ctx.answerCbQuery('⚠️ Invalid page number.', { show_alert: true });
  }
  await sendBaseContent(ctx, index);
  ctx.answerCbQuery(); // Acknowledge the callback
});

// Exit the "Learn About Base" Section
bot.action('exit_base', async (ctx) => {
  // Delete the message and clear session
  if (ctx.session.baseMessageId) {
    await ctx.deleteMessage(ctx.session.baseMessageId).catch(() => {});
    ctx.session.baseMessageId = null;
  }
  await ctx.replyWithMarkdown('Thank you for learning about Base!');
  ctx.answerCbQuery();
});

// =================== Admin Functionality: Send Broadcast Messages ===================

bot.on('message', async (ctx, next) => {
  const userId = ctx.from.id.toString();
  let userState;
  try {
    userState = await getUserState(userId);
  } catch (error) {
    logger.error(`Error fetching user state for ${userId}: ${error.message}`);
    await ctx.reply('⚠️ An error occurred. Please try again later.');
    return;
  }

  if (userState.awaitingBroadcastMessage) {
    const message = ctx.message;

    if (message.photo) {
      // Broadcast with Photo
      const photoArray = message.photo;
      const highestResolutionPhoto = photoArray[photoArray.length - 1]; // Get the highest resolution photo
      const fileId = highestResolutionPhoto.file_id;
      const caption = message.caption || '';

      try {
        // Send the photo with caption to the target users
        let successCount = 0;
        let failureCount = 0;

        const usersSnapshot = await db.collection('users').get();
        if (usersSnapshot.empty) {
          await ctx.reply('No users to broadcast to.', getAdminMenu());
          await updateUserState(userId, { awaitingBroadcastMessage: false });
          return;
        }

        // Initialize rate limiter to prevent hitting Telegram's rate limits
        const limiter = new Bottleneck({
          minTime: 200, // 200ms between requests
          maxConcurrent: 5, // Maximum 5 concurrent requests
        });

        // Wrap the sendPhoto function with the limiter
        const limitedSendPhoto = limiter.wrap(bot.telegram.sendPhoto.bind(bot.telegram));

        for (const doc of usersSnapshot.docs) {
          const targetUserId = doc.id;
          try {
            await limitedSendPhoto(targetUserId, fileId, { caption: caption, parse_mode: 'Markdown' });
            successCount++;
          } catch (error) {
            logger.error(`Error sending broadcast photo to user ${targetUserId}: ${error.message}`);
            failureCount++;
          }
        }

        await ctx.reply(`✅ Broadcast completed.\n\n📬 Successful: ${successCount}\n❌ Failed: ${failureCount}`, getAdminMenu());
        logger.info(`Admin ${userId} broadcasted photo message. Success: ${successCount}, Failed: ${failureCount}`);
      } catch (error) {
        logger.error(`Broadcast Photo Error: ${error.message}`);
        await ctx.replyWithMarkdown('⚠️ An error occurred while broadcasting the photo. Please try again later.', getAdminMenu());
      }
    } else if (message.text) {
      // Broadcast with Text
      const broadcastMessage = message.text.trim();
      if (!broadcastMessage) {
        return ctx.reply('❌ Message content cannot be empty. Please enter a valid message:');
      }

      try {
        let successCount = 0;
        let failureCount = 0;

        const usersSnapshot = await db.collection('users').get();
        if (usersSnapshot.empty) {
          await ctx.reply('No users to broadcast to.', getAdminMenu());
          await updateUserState(userId, { awaitingBroadcastMessage: false });
          return;
        }

        // Initialize rate limiter to prevent hitting Telegram's rate limits
        const limiter = new Bottleneck({
          minTime: 200, // 200ms between requests
          maxConcurrent: 5, // Maximum 5 concurrent requests
        });

        // Wrap the sendMessage function with the limiter
        const limitedSendMessage = limiter.wrap(bot.telegram.sendMessage.bind(bot.telegram));

        for (const doc of usersSnapshot.docs) {
          const targetUserId = doc.id;
          try {
            await limitedSendMessage(targetUserId, `📢 *Broadcast Message:*\n\n${broadcastMessage}`, { parse_mode: 'Markdown' });
            successCount++;
          } catch (error) {
            logger.error(`Error sending broadcast message to user ${targetUserId}: ${error.message}`);
            failureCount++;
          }
        }

        await ctx.reply(`✅ Broadcast completed.\n\n📬 Successful: ${successCount}\n❌ Failed: ${failureCount}`, getAdminMenu());
        logger.info(`Admin ${userId} broadcasted message. Success: ${successCount}, Failed: ${failureCount}`);
      } catch (error) {
        logger.error(`Broadcast Text Error: ${error.message}`);
        await ctx.replyWithMarkdown('⚠️ An error occurred while broadcasting the message. Please try again later.', getAdminMenu());
      }
    } else {
      // Unsupported message type
      await ctx.reply('❌ Unsupported message type. Please send text or a photo (receipt).', getAdminMenu());
    }

    // Reset broadcast message state
    await updateUserState(userId, { awaitingBroadcastMessage: false });
  }

  await next(); // Pass control to the next handler
});

// Handle Broadcast Message Input
bot.hears('📣 Broadcast Message', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    return ctx.reply('⚠️ Unauthorized access.');
  }
  // Set state to indicate awaiting broadcast message
  await updateUserState(userId, { awaitingBroadcastMessage: true });
  await ctx.reply('📢 Please enter the message you want to broadcast to all users. You can also attach an image (receipt) with your message.');
});

// =================== Bank Linking Scene Exit ===================

bankLinkingScene.leave((ctx) => {
  delete ctx.session.walletIndex;
  delete ctx.session.bankData;
  delete ctx.session.processType;
  delete ctx.session.isBankLinking;
  if (ctx.session.bankLinkingTimeout) {
    clearTimeout(ctx.session.bankLinkingTimeout);
    delete ctx.session.bankLinkingTimeout;
  }
});

// =================== Admin Functionality Helpers ===================

/**
 * Placeholder function to map assets and chains to Paycrest requirements.
 * Replace with actual mapping logic.
 */
function mapToPaycrest(asset, chain) {
  // Implement your mapping logic here
  // For demonstration, return a dummy mapping
  return {
    assetId: 'PAYCREST_ASSET_ID',
    network: chain,
  };
}

// =================== Handle "ℹ️ Support" Actions ===================

// Existing support actions are already handled above

// =================== Telegram Webhook Setup ===================

const appExpress = express();
appExpress.use(express.json());

// Paycrest Webhook Endpoint
appExpress.post('/webhook/paycrest', async (req, res) => {
  const signature = req.headers['x-paycrest-signature'];
  const secretKey = process.env.PAYCREST_CLIENT_SECRET;

  if (!verifyPaycrestSignature(JSON.stringify(req.body), signature, secretKey)) {
    logger.error('Invalid Paycrest signature');
    return res.status(401).send('Invalid signature');
  }

  const event = req.body.event;
  const data = req.body.data;

  if (event === 'payment_order.settled') {
    const orderId = data.id;

    try {
      // Fetch transaction by paycrestOrderId
      const txSnapshot = await db.collection('transactions').where('paycrestOrderId', '==', orderId).limit(1).get();
      if (txSnapshot.empty) {
        logger.error(`No transaction found for Paycrest orderId: ${orderId}`);
        return res.status(200).send('OK');
      }

      const txDoc = txSnapshot.docs[0];
      const txData = txDoc.data();
      const userId = txData.userId;
      const messageId = txData.messageId;

      // Update transaction to Paid
      await db.collection('transactions').doc(txDoc.id).update({ status: 'Paid' });

      // Notify user
      await bot.telegram.sendMessage(userId, `🎉 *Funds Credited Successfully!*\n\n` +
        `Hello ${txData.bankDetails.accountName || 'Valued User'},\n\n` +
        `Your DirectPay order has been completed. Here are the details of your order:\n\n` +
        `*Crypto amount:* ${txData.amount} ${txData.asset}\n` +
        `*Cash amount:* NGN ${txData.payout}\n` +
        `*Network:* ${txData.chain}\n` +
        `*Date:* ${new Date(txData.timestamp).toISOString()}\n\n` +
        `Thank you for using *DirectPay*! Your funds have been securely transferred to your bank account. If you have any questions or need further assistance, feel free to [contact our support team](https://t.me/maxcswap).`,
        { parse_mode: 'Markdown' }
      );

      // Optionally, edit the pending message to indicate completion
      if (messageId) {
        try {
          await bot.telegram.editMessageText(userId, messageId, null, `🎉 *Funds Credited Successfully!*\n\n` +
            `Your DirectPay order has been completed. Here are the details of your order:\n\n` +
            `*Crypto amount:* ${txData.amount} ${txData.asset}\n` +
            `*Cash amount:* NGN ${txData.payout}\n` +
            `*Network:* ${txData.chain}\n` +
            `*Date:* ${new Date(txData.timestamp).toISOString()}\n\n` +
            `Thank you for using *DirectPay*! Your funds have been securely transferred to your bank account.`,
            { parse_mode: 'Markdown' }
          );
        } catch (error) {
          logger.error(`Error editing message for user ${userId}: ${error.message}`);
          // Optionally, notify admin about the failure to edit message
          await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Failed to edit message for user ${userId}: ${error.message}`);
        }
      }

      // Notify admin about the successful payment
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `✅ *Payment Completed*\n\n` +
        `*User ID:* ${userId}\n` +
        `*Reference ID:* ${txData.referenceId}\n` +
        `*Amount:* ${txData.amount} ${txData.asset}\n` +
        `*Bank:* ${txData.bankDetails.bankName}\n` +
        `*Account Number:* ****${txData.bankDetails.accountNumber.slice(-4)}\n` +
        `*Date:* ${new Date(txData.timestamp).toLocaleString()}\n`, { parse_mode: 'Markdown' });

      res.status(200).send('OK');
    } catch (error) {
      logger.error(`Error processing Paycrest webhook for orderId ${orderId}: ${error.message}`);
      res.status(500).send('Error');
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error processing Paycrest webhook for orderId ${orderId}: ${error.message}`, { parse_mode: 'Markdown' });
    }
  } else {
    logger.info(`Unhandled Paycrest event: ${event}`);
    res.status(200).send('OK');
  }
});

/**
 * Verifies Paycrest webhook signature.
 */
function verifyPaycrestSignature(requestBody, signatureHeader, secretKey) {
  const calculatedSignature = calculateHmacSignature(requestBody, secretKey);
  return signatureHeader === calculatedSignature;
}

/**
 * Calculates HMAC SHA256 signature.
 */
function calculateHmacSignature(data, secretKey) {
  const key = Buffer.from(secretKey);
  const hash = crypto.createHmac('sha256', key);
  hash.update(data);
  return hash.digest('hex');
}

// Blockradar Webhook Endpoint
appExpress.post('/webhook/blockradar', async (req, res) => {
  try {
    const event = req.body;
    logger.info(`Received Blockradar webhook: ${JSON.stringify(event)}`);
    fs.appendFileSync(path.join(__dirname, 'webhook_logs.txt'), `${new Date().toISOString()} - ${JSON.stringify(event, null, 2)}\n`);

    // Extract common event data
    const eventType = event.event || 'Unknown Event';
    const walletAddress = event.data?.recipientAddress || 'N/A';
    const amount = parseFloat(event.data?.amount) || 0;
    const asset = event.data?.asset?.symbol || 'N/A';
    const transactionHash = event.data?.hash || 'N/A';
    const chainRaw = event.data?.blockchain?.name || 'N/A';

    // Normalize and map the chain name
    const chainKey = chainMapping[chainRaw.toLowerCase()];
    if (!chainKey) {
      logger.error(`Unknown chain received in webhook: ${chainRaw}`);
      // Notify admin about the unknown chain
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ Received deposit on unknown chain: \`${chainRaw}\``);
      return res.status(400).send('Unknown chain.');
    }

    const chain = chainKey;

    if (eventType === 'deposit.success') { // Handle 'deposit.success' event
      if (walletAddress === 'N/A') {
        logger.error('Webhook missing wallet address.');
        return res.status(400).send('Missing wallet address.');
      }

      // **Duplicate Check Start**
      // Check if a transaction with the same hash already exists
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
        // Notify admin about the unmatched wallet
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ No user found for wallet address: \`${walletAddress}\``);
        return res.status(200).send('OK');
      }

      const userDoc = usersSnapshot.docs[0];
      const userId = userDoc.id;
      const userState = userDoc.data();
      const wallet = userState.wallets.find((w) => w.address === walletAddress);

      // Check if Wallet has Linked Bank
      if (!wallet || !wallet.bank) {
        await bot.telegram.sendMessage(userId, `💰 *Deposit Received:* ${amount} ${asset} on ${chainRaw}.\n\nPlease link a bank account to receive your payout securely.`, { parse_mode: 'Markdown' });
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ User ${userId} has received a deposit but hasn't linked a bank account.`, { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      }

      // Only support USDC and USDT
      if (!['USDC', 'USDT'].includes(asset)) {
        await bot.telegram.sendMessage(userId, `⚠️ *Unsupported Asset Deposited:* ${asset}.\n\nCurrently, only *USDC* and *USDT* are supported. Please contact support if you believe this is an error.`, { parse_mode: 'Markdown' });
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ User ${userId} deposited unsupported asset: ${asset}.`, { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      }

      // Get the latest exchange rate (ensure exchangeRates are updated dynamically)
      const rate = exchangeRates[asset];
      if (!rate) {
        throw new Error(`Exchange rate for ${asset} not available.`);
      }

      // Calculate the NGN amount based on the current exchange rate
      const ngnAmount = calculatePayout(asset, amount, exchangeRates);

      const referenceId = generateReferenceId();
      const bankName = wallet.bank.bankName || 'N/A';
      const bankAccount = wallet.bank.accountNumber || 'N/A';
      const accountName = wallet.bank.accountName || 'Valued User';

      // Fetch the user's first name
      const userFirstName = userState.firstName || 'Valued User';

      // Create Transaction Document with Status 'Processing' and store messageId as null initially
      const transactionRef = await db.collection('transactions').add({
        userId,
        walletAddress,
        chain: chainRaw,
        amount: amount,
        asset: asset,
        transactionHash: transactionHash,
        referenceId: referenceId,
        bankDetails: wallet.bank,
        payout: ngnAmount, // Store NGN payout
        timestamp: new Date().toISOString(),
        status: 'Processing',
        paycrestOrderId: '', // To be updated upon Paycrest order creation
        messageId: null // To be set after sending the pending message
      });

      // Send Detailed Pending Message to User
      const pendingMessage = await bot.telegram.sendMessage(userId,
        `🎉 *Deposit Received!*\n\n` +
        `*Reference ID:* \`${referenceId}\`\n` +
        `*Amount Deposited:* ${amount} ${asset}\n` +
        `*Network:* ${chainRaw}\n\n` +
        `🔄 *Your order has begun processing!* ⏳\n\n` +
        `We are converting your crypto to NGN at the current exchange rate of ₦${rate} per ${asset}. Your cash will be credited to your linked bank account shortly.\n\n` +
        `Thank you for using *DirectPay*!`,
        { parse_mode: 'Markdown' }
      );

      // Update the transaction document with message_id
      await transactionRef.update({
        messageId: pendingMessage.message_id
      });

      // Notify admin with detailed deposit information
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
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, adminDepositMessage, { parse_mode: 'Markdown' });

      // Integrate Paycrest to off-ramp automatically
      const paycrestMapping = mapToPaycrest(asset, chainRaw);
      if (!paycrestMapping) {
        logger.error('No Paycrest mapping for this asset/chain.');
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ No Paycrest mapping found for asset ${asset} on chain ${chainRaw}.`);
        return res.status(200).send('OK');
      }

      // Create Paycrest order
      let paycrestOrder;
      try {
        paycrestOrder = await createPaycrestOrder(userId, amount, asset, chainRaw, wallet.bank); // Pass token amount
        await transactionRef.update({ paycrestOrderId: paycrestOrder.id });
      } catch (err) {
        logger.error(`Error creating Paycrest order for user ${userId}: ${err.message}`);
        // Notify admin about the failure
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error creating Paycrest order for user ${userId}: ${err.message}`);
        // Update transaction status to 'Failed'
        await transactionRef.update({ status: 'Failed' });
        // Update user's pending message to indicate failure
        const failureMessage = `Hello ${userFirstName},\n\n` +
          `⚠️ *Your DirectPay order has failed to process.*\n\n` +
          `Please contact our support team for assistance.`;
        await bot.telegram.editMessageText(userId, pendingMessage.message_id, null, failureMessage, { parse_mode: 'Markdown' });
        return res.status(500).send('Paycrest order error');
      }

      const receiveAddress = paycrestOrder.receiveAddress;

      // Withdraw from Blockradar to Paycrest receiveAddress
      let blockradarAssetId;
      switch (asset) {
        case 'USDC':
          blockradarAssetId = process.env.BLOCKRADAR_USDC_ASSET_ID || 'YOUR_BLOCKRADAR_USDC_ASSET_ID'; // Ensure this environment variable is set
          break;
        case 'USDT':
          blockradarAssetId = process.env.BLOCKRADAR_USDT_ASSET_ID || 'YOUR_BLOCKRADAR_USDT_ASSET_ID'; // Ensure this environment variable is set
          break;
        default:
          throw new Error(`Unsupported asset: ${asset}`);
      }

      try {
        await withdrawFromBlockradar(chainRaw, blockradarAssetId, receiveAddress, amount, paycrestOrder.id, { userId, originalTxHash: transactionHash });
      } catch (err) {
        logger.error(`Error withdrawing from Blockradar for user ${userId}: ${err.response ? err.response.data.message : err.message}`);
        // Notify admin about this failure
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error withdrawing from Blockradar for user ${userId}: ${err.response ? err.response.data.message : err.message}`);
        // Update transaction status to 'Failed'
        await transactionRef.update({ status: 'Failed' });
        // Update user's pending message to indicate failure
        const failureMessage = `Hello ${userFirstName},\n\n` +
          `⚠️ *Your DirectPay order has failed to process.*\n\n` +
          `Please contact our support team for assistance.`;
        await bot.telegram.editMessageText(userId, pendingMessage.message_id, null, failureMessage, { parse_mode: 'Markdown' });
        return res.status(500).send('Blockradar withdrawal error');
      }

      // Store Transaction in Firestore
      await db.collection('transactions').doc(transactionRef.id).update({
        status: 'Pending',
        paycrestOrderId: paycrestOrder.id
      });

      logger.info(`Transaction stored for user ${userId}: Reference ID ${paycrestOrder.id}`);

      // Update User's Pending Message to Final Success Message
      const finalMessage = `🎉 *Funds Credited Successfully!*\n\n` +
        `Hello ${userFirstName},\n\n` +
        `Your DirectPay order has been completed. Here are the details of your order:\n\n` +
        `*Crypto amount:* ${amount} ${asset}\n` +
        `*Cash amount:* NGN ${ngnAmount}\n` +
        `*Network:* ${chainRaw}\n` +
        `*Date:* ${new Date(txData.timestamp).toISOString()}\n\n` +
        `To help us keep improving our services, please rate your experience with us.`;

      try {
        await bot.telegram.editMessageText(userId, pendingMessage.message_id, null, finalMessage, { parse_mode: 'Markdown' });
        // Update transaction status to 'Completed'
        await db.collection('transactions').doc(transactionRef.id).update({ status: 'Completed' });
      } catch (error) {
        logger.error(`Error editing message for user ${userId}: ${error.message}`);
        // Optionally, notify admin about the failure to edit message
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Failed to edit message for user ${userId}: ${error.message}`);
      }

      // Reset Bank Linking Flags and Session Variables
      delete ctx.session.walletIndex;
      delete ctx.session.bankData;
      delete ctx.session.processType;
      delete ctx.session.isBankLinking; // Reset the bank linking flag

      // Clear the inactivity timeout
      if (ctx.session.bankLinkingTimeout) {
        clearTimeout(ctx.session.bankLinkingTimeout);
        delete ctx.session.bankLinkingTimeout;
      }

      res.status(200).send('OK');
    }
  } catch (error) {
    logger.error(`Error processing Blockradar webhook: ${error.message}`);
    res.status(500).send('Error processing webhook');
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error processing Blockradar webhook: ${error.message}`);
  }
});

// =================== Webhook Handlers ===================

/**
 * Verifies Paycrest webhook signature.
 */
function verifyPaycrestSignature(requestBody, signatureHeader, secretKey) {
  const calculatedSignature = calculateHmacSignature(requestBody, secretKey);
  return signatureHeader === calculatedSignature;
}

/**
 * Calculates HMAC SHA256 signature.
 */
function calculateHmacSignature(data, secretKey) {
  const key = Buffer.from(secretKey);
  const hash = crypto.createHmac('sha256', key);
  hash.update(data);
  return hash.digest('hex');
}

// =================== Express App Initialization ===================

const app = express();
app.use(express.json());

// Paycrest Webhook Endpoint
app.post('/webhook/paycrest', async (req, res) => {
  const signature = req.headers['x-paycrest-signature'];
  const secretKey = process.env.PAYCREST_CLIENT_SECRET;

  if (!verifyPaycrestSignature(JSON.stringify(req.body), signature, secretKey)) {
    logger.error('Invalid Paycrest signature');
    return res.status(401).send('Invalid signature');
  }

  const event = req.body.event;
  const data = req.body.data;

  if (event === 'payment_order.settled') {
    const orderId = data.id;

    try {
      // Fetch transaction by paycrestOrderId
      const txSnapshot = await db.collection('transactions').where('paycrestOrderId', '==', orderId).limit(1).get();
      if (txSnapshot.empty) {
        logger.error(`No transaction found for Paycrest orderId: ${orderId}`);
        return res.status(200).send('OK');
      }

      const txDoc = txSnapshot.docs[0];
      const txData = txDoc.data();
      const userId = txData.userId;
      const messageId = txData.messageId;

      // Update transaction to Paid
      await db.collection('transactions').doc(txDoc.id).update({ status: 'Paid' });

      // Notify user
      await bot.telegram.sendMessage(userId, `🎉 *Funds Credited Successfully!*\n\n` +
        `Hello ${txData.bankDetails.accountName || 'Valued User'},\n\n` +
        `Your DirectPay order has been completed. Here are the details of your order:\n\n` +
        `*Crypto amount:* ${txData.amount} ${txData.asset}\n` +
        `*Cash amount:* NGN ${txData.payout}\n` +
        `*Network:* ${txData.chain}\n` +
        `*Date:* ${new Date(txData.timestamp).toISOString()}\n\n` +
        `Thank you for using *DirectPay*! Your funds have been securely transferred to your bank account. If you have any questions or need further assistance, feel free to [contact our support team](https://t.me/maxcswap).`,
        { parse_mode: 'Markdown' }
      );

      // Optionally, edit the pending message to indicate completion
      if (messageId) {
        try {
          await bot.telegram.editMessageText(userId, messageId, null, `🎉 *Funds Credited Successfully!*\n\n` +
            `Your DirectPay order has been completed. Here are the details of your order:\n\n` +
            `*Crypto amount:* ${txData.amount} ${txData.asset}\n` +
            `*Cash amount:* NGN ${txData.payout}\n` +
            `*Network:* ${txData.chain}\n` +
            `*Date:* ${new Date(txData.timestamp).toISOString()}\n\n` +
            `Thank you for using *DirectPay*! Your funds have been securely transferred to your bank account.`,
            { parse_mode: 'Markdown' }
          );
        } catch (error) {
          logger.error(`Error editing message for user ${userId}: ${error.message}`);
          // Optionally, notify admin about the failure to edit message
          await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Failed to edit message for user ${userId}: ${error.message}`);
        }
      }

      // Notify admin about the successful payment
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `✅ *Payment Completed*\n\n` +
        `*User ID:* ${userId}\n` +
        `*Reference ID:* ${txData.referenceId}\n` +
        `*Amount:* ${txData.amount} ${txData.asset}\n` +
        `*Bank:* ${txData.bankDetails.bankName}\n` +
        `*Account Number:* ****${txData.bankDetails.accountNumber.slice(-4)}\n` +
        `*Date:* ${new Date(txData.timestamp).toLocaleString()}\n`, { parse_mode: 'Markdown' });

      res.status(200).send('OK');
    } catch (error) {
      logger.error(`Error processing Paycrest webhook for orderId ${orderId}: ${error.message}`);
      res.status(500).send('Error');
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error processing Paycrest webhook for orderId ${orderId}: ${error.message}`, { parse_mode: 'Markdown' });
    }
  } else {
    logger.info(`Unhandled Paycrest event: ${event}`);
    res.status(200).send('OK');
  }
});

// Blockradar Webhook Endpoint
app.post('/webhook/blockradar', async (req, res) => {
  try {
    const event = req.body;
    logger.info(`Received Blockradar webhook: ${JSON.stringify(event)}`);
    fs.appendFileSync(path.join(__dirname, 'webhook_logs.txt'), `${new Date().toISOString()} - ${JSON.stringify(event, null, 2)}\n`);

    // Extract common event data
    const eventType = event.event || 'Unknown Event';
    const walletAddress = event.data?.recipientAddress || 'N/A';
    const amount = parseFloat(event.data?.amount) || 0;
    const asset = event.data?.asset?.symbol || 'N/A';
    const transactionHash = event.data?.hash || 'N/A';
    const chainRaw = event.data?.blockchain?.name || 'N/A';

    // Normalize and map the chain name
    const chainKey = chainMapping[chainRaw.toLowerCase()];
    if (!chainKey) {
      logger.error(`Unknown chain received in webhook: ${chainRaw}`);
      // Notify admin about the unknown chain
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ Received deposit on unknown chain: \`${chainRaw}\``);
      return res.status(400).send('Unknown chain.');
    }

    const chain = chainKey;

    if (eventType === 'deposit.success') { // Handle 'deposit.success' event
      if (walletAddress === 'N/A') {
        logger.error('Webhook missing wallet address.');
        return res.status(400).send('Missing wallet address.');
      }

      // **Duplicate Check Start**
      // Check if a transaction with the same hash already exists
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
        // Notify admin about the unmatched wallet
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ No user found for wallet address: \`${walletAddress}\``);
        return res.status(200).send('OK');
      }

      const userDoc = usersSnapshot.docs[0];
      const userId = userDoc.id;
      const userState = userDoc.data();
      const wallet = userState.wallets.find((w) => w.address === walletAddress);

      // Check if Wallet has Linked Bank
      if (!wallet || !wallet.bank) {
        await bot.telegram.sendMessage(userId, `💰 *Deposit Received:* ${amount} ${asset} on ${chainRaw}.\n\nPlease link a bank account to receive your payout securely.`, { parse_mode: 'Markdown' });
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ User ${userId} has received a deposit but hasn't linked a bank account.`, { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      }

      // Only support USDC and USDT
      if (!['USDC', 'USDT'].includes(asset)) {
        await bot.telegram.sendMessage(userId, `⚠️ *Unsupported Asset Deposited:* ${asset}.\n\nCurrently, only *USDC* and *USDT* are supported. Please contact support if you believe this is an error.`, { parse_mode: 'Markdown' });
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ User ${userId} deposited unsupported asset: ${asset}.`, { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      }

      // Get the latest exchange rate (ensure exchangeRates are updated dynamically)
      const rate = exchangeRates[asset];
      if (!rate) {
        throw new Error(`Exchange rate for ${asset} not available.`);
      }

      // Calculate the NGN amount based on the current exchange rate
      const ngnAmount = calculatePayout(asset, amount, exchangeRates);

      const referenceId = generateReferenceId();
      const bankName = wallet.bank.bankName || 'N/A';
      const bankAccount = wallet.bank.accountNumber || 'N/A';
      const accountName = wallet.bank.accountName || 'Valued User';

      // Fetch the user's first name
      const userFirstName = userState.firstName || 'Valued User';

      // Create Transaction Document with Status 'Processing' and store messageId as null initially
      const transactionRef = await db.collection('transactions').add({
        userId,
        walletAddress,
        chain: chainRaw,
        amount: amount,
        asset: asset,
        transactionHash: transactionHash,
        referenceId: referenceId,
        bankDetails: wallet.bank,
        payout: ngnAmount, // Store NGN payout
        timestamp: new Date().toISOString(),
        status: 'Processing',
        paycrestOrderId: '', // To be updated upon Paycrest order creation
        messageId: null // To be set after sending the pending message
      });

      // Send Detailed Pending Message to User
      const pendingMessage = await bot.telegram.sendMessage(userId,
        `🎉 *Deposit Received!*\n\n` +
        `*Reference ID:* \`${referenceId}\`\n` +
        `*Amount Deposited:* ${amount} ${asset}\n` +
        `*Network:* ${chainRaw}\n\n` +
        `🔄 *Your order has begun processing!* ⏳\n\n` +
        `We are converting your crypto to NGN at the current exchange rate of ₦${rate} per ${asset}. Your cash will be credited to your linked bank account shortly.\n\n` +
        `Thank you for using *DirectPay*!`,
        { parse_mode: 'Markdown' }
      );

      // Update the transaction document with message_id
      await transactionRef.update({
        messageId: pendingMessage.message_id
      });

      // Notify admin with detailed deposit information
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
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, adminDepositMessage, { parse_mode: 'Markdown' });

      // Integrate Paycrest to off-ramp automatically
      const paycrestMapping = mapToPaycrest(asset, chainRaw);
      if (!paycrestMapping) {
        logger.error('No Paycrest mapping for this asset/chain.');
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ No Paycrest mapping found for asset ${asset} on chain ${chainRaw}.`);
        return res.status(200).send('OK');
      }

      // Create Paycrest order
      let paycrestOrder;
      try {
        paycrestOrder = await createPaycrestOrder(userId, amount, asset, chainRaw, wallet.bank); // Pass token amount
        await transactionRef.update({ paycrestOrderId: paycrestOrder.id });
      } catch (err) {
        logger.error(`Error creating Paycrest order for user ${userId}: ${err.message}`);
        // Notify admin about the failure
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error creating Paycrest order for user ${userId}: ${err.message}`);
        // Update transaction status to 'Failed'
        await transactionRef.update({ status: 'Failed' });
        // Update user's pending message to indicate failure
        const failureMessage = `Hello ${userFirstName},\n\n` +
          `⚠️ *Your DirectPay order has failed to process.*\n\n` +
          `Please contact our support team for assistance.`;
        await bot.telegram.editMessageText(userId, pendingMessage.message_id, null, failureMessage, { parse_mode: 'Markdown' });
        return res.status(500).send('Paycrest order error');
      }

      const receiveAddress = paycrestOrder.receiveAddress;

      // Withdraw from Blockradar to Paycrest receiveAddress
      let blockradarAssetId;
      switch (asset) {
        case 'USDC':
          blockradarAssetId = process.env.BLOCKRADAR_USDC_ASSET_ID || 'YOUR_BLOCKRADAR_USDC_ASSET_ID'; // Ensure this environment variable is set
          break;
        case 'USDT':
          blockradarAssetId = process.env.BLOCKRADAR_USDT_ASSET_ID || 'YOUR_BLOCKRADAR_USDT_ASSET_ID'; // Ensure this environment variable is set
          break;
        default:
          throw new Error(`Unsupported asset: ${asset}`);
      }

      try {
        await withdrawFromBlockradar(chainRaw, blockradarAssetId, receiveAddress, amount, paycrestOrder.id, { userId, originalTxHash: transactionHash });
      } catch (err) {
        logger.error(`Error withdrawing from Blockradar for user ${userId}: ${err.response ? err.response.data.message : err.message}`);
        // Notify admin about this failure
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error withdrawing from Blockradar for user ${userId}: ${err.response ? err.response.data.message : err.message}`);
        // Update transaction status to 'Failed'
        await transactionRef.update({ status: 'Failed' });
        // Update user's pending message to indicate failure
        const failureMessage = `Hello ${userFirstName},\n\n` +
          `⚠️ *Your DirectPay order has failed to process.*\n\n` +
          `Please contact our support team for assistance.`;
        await bot.telegram.editMessageText(userId, pendingMessage.message_id, null, failureMessage, { parse_mode: 'Markdown' });
        return res.status(500).send('Blockradar withdrawal error');
      }

      // Store Transaction in Firestore
      await db.collection('transactions').doc(transactionRef.id).update({
        status: 'Pending',
        paycrestOrderId: paycrestOrder.id
      });

      logger.info(`Transaction stored for user ${userId}: Reference ID ${paycrestOrder.id}`);

      // Update User's Pending Message to Final Success Message
      const finalMessage = `🎉 *Funds Credited Successfully!*\n\n` +
        `Hello ${userFirstName},\n\n` +
        `Your DirectPay order has been completed. Here are the details of your order:\n\n` +
        `*Crypto amount:* ${amount} ${asset}\n` +
        `*Cash amount:* NGN ${ngnAmount}\n` +
        `*Network:* ${chainRaw}\n` +
        `*Date:* ${new Date(txData.timestamp).toISOString()}\n\n` +
        `To help us keep improving our services, please rate your experience with us.`;

      try {
        await bot.telegram.editMessageText(userId, pendingMessage.message_id, null, finalMessage, { parse_mode: 'Markdown' });
        // Update transaction status to 'Completed'
        await db.collection('transactions').doc(transactionRef.id).update({ status: 'Completed' });
      } catch (error) {
        logger.error(`Error editing message for user ${userId}: ${error.message}`);
        // Optionally, notify admin about the failure to edit message
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Failed to edit message for user ${userId}: ${error.message}`);
      }

      // Reset Bank Linking Flags and Session Variables
      delete ctx.session.walletIndex;
      delete ctx.session.bankData;
      delete ctx.session.processType;
      delete ctx.session.isBankLinking; // Reset the bank linking flag

      // Clear the inactivity timeout
      if (ctx.session.bankLinkingTimeout) {
        clearTimeout(ctx.session.bankLinkingTimeout);
        delete ctx.session.bankLinkingTimeout;
      }

      res.status(200).send('OK');
    }
  } catch (error) {
    logger.error(`Error processing Blockradar webhook: ${error.message}`);
    res.status(500).send('Error processing webhook');
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error processing Blockradar webhook: ${error.message}`);
  }
});

// =================== Telegram Webhook Handler ===================

/**
 * Sets the Telegram webhook.
 */
(async () => {
  try {
    await bot.telegram.setWebhook(`${TELEGRAM_WEBHOOK_URL}${TELEGRAM_WEBHOOK_PATH}`);
    logger.info(`Telegram webhook set to ${TELEGRAM_WEBHOOK_URL}${TELEGRAM_WEBHOOK_PATH}`);
  } catch (error) {
    logger.error(`Failed to set Telegram webhook: ${error.message}`);
    process.exit(1);
  }
})();

/**
 * Handles incoming updates from Telegram.
 */
appExpress.post(TELEGRAM_WEBHOOK_PATH, (req, res) => {
  bot.handleUpdate(req.body, res);
});

// =================== Unhandled Rejection and Exception Handling ===================

process.on('unhandledRejection', (reason, promise) => {
  logger.error(`Unhandled Rejection at: ${promise} - reason: ${reason}`);
  bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Unhandled Rejection: ${reason}`);
});

process.on('uncaughtException', (error) => {
  logger.error(`Uncaught Exception: ${error.message}`);
  bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Uncaught Exception: ${error.message}`);
  process.exit(1); // Exit to prevent the app from running in an unstable state
});

// =================== Functions to Handle Admin Verification ===================

function isAdmin(userId) {
  const adminIds = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',') : [];
  return adminIds.includes(userId);
}

// =================== Express Server Setup ===================

const PORT = process.env.PORT || 4000;
appExpress.listen(PORT, () => {
  logger.info(`Webhook server running on port ${PORT}`);
});

// =================== Graceful Shutdown ===================

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
