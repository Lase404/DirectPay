const { Scenes, Markup } = require('telegraf');
const { v4: uuidv4 } = require('uuid');

const bankLinkingSceneTemp = new Scenes.WizardScene(
  'bank_linking_scene_temp',
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const userState = await getUserState(userId);
    const prompt = userState.usePidgin
      ? '🏦 Enter your bank name for this sell (e.g., GTBank, Access):'
      : '🏦 Please enter your bank name for this sell (e.g., GTBank, Access):';
    await ctx.replyWithMarkdown(prompt);
    ctx.wizard.state.data = { userId };
    return ctx.wizard.next();
  },
  async (ctx) => {
    const bankNameInput = ctx.message.text.trim();
    const userState = await getUserState(ctx.wizard.state.data.userId);

    if (bankNameInput.toLowerCase() === 'exit') {
      await ctx.replyWithMarkdown(userState.usePidgin ? '❌ Cancelled.' : '❌ Cancelled.');
      return ctx.scene.leave();
    }

    const { bank, distance } = findClosestBank(bankNameInput, bankList);
    if (!bank || distance > 3) {
      const errorMsg = userState.usePidgin
        ? `❌ Bank name no match o. Check am or try:\n\n${bankList.map(b => `• ${b.name}`).join('\n')}\n\nTry again or type "exit" to stop:`
        : `❌ No matching bank found. Check your input or try:\n\n${bankList.map(b => `• ${b.name}`).join('\n')}\n\nTry again or type "exit" to cancel:`;
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }

    if (distance > 0 && distance <= 3) {
      const confirmMsg = userState.usePidgin
        ? `You mean *${bank.name}*? You type "${bankNameInput}".\n\nCorrect?`
        : `Did you mean *${bank.name}*? You entered "${bankNameInput}".\n\nIs this correct?`;
      ctx.wizard.state.data.suggestedBank = bank;
      const sentMessage = await ctx.replyWithMarkdown(confirmMsg, Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes', 'confirm_suggested_bank')],
        [Markup.button.callback('❌ No', 'retry_bank_name')]
      ]));
      ctx.wizard.state.suggestionMessageId = sentMessage.message_id;
      return;
    }

    ctx.wizard.state.data.bankName = bank.name;
    ctx.wizard.state.data.bankCode = bank.code;
    const prompt = userState.usePidgin
      ? '🔢 Enter your 10-digit account number:'
      : '🔢 Please enter your 10-digit account number:';
    await ctx.replyWithMarkdown(prompt);
    return ctx.wizard.next();
  },
  async (ctx) => {
    const accountNumber = ctx.message.text.trim();
    const userState = await getUserState(ctx.wizard.state.data.userId);

    if (accountNumber.toLowerCase() === 'exit') {
      await ctx.replyWithMarkdown(userState.usePidgin ? '❌ Cancelled.' : '❌ Cancelled.');
      return ctx.scene.leave();
    }

    if (!/^\d{10}$/.test(accountNumber)) {
      const errorMsg = userState.usePidgin
        ? '❌ Account number no correct. Enter valid 10-digit number or type "exit" to stop:'
        : '❌ Invalid account number. Enter a valid 10-digit number or type "exit" to cancel:';
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }

    const verifyingMsg = userState.usePidgin
      ? '🔄 Checking your bank details...'
      : '🔄 Verifying your bank details...';
    await ctx.replyWithMarkdown(verifyingMsg);

    try {
      const verificationResult = await verifyBankAccount(accountNumber, ctx.wizard.state.data.bankCode);
      if (!verificationResult || !verificationResult.data || !verificationResult.data.account_name) {
        throw new Error('Invalid verification response');
      }

      const relayAddress = `relay_${uuidv4().replace(/-/g, '')}`; // Relay-style address
      ctx.wizard.state.data.bankDetails = {
        bankName: ctx.wizard.state.data.bankName,
        accountNumber,
        accountName: verificationResult.data.account_name,
        relayAddress,
      };

      const confirmMsg = userState.usePidgin
        ? `🏦 *Bank Account Check*\n\n` +
          `Confirm your details for this sell:\n` +
          `- *Bank Name:* ${ctx.wizard.state.data.bankName}\n` +
          `- *Account Number:* \`${accountNumber}\`\n` +
          `- *Account Holder:* ${verificationResult.data.account_name}\n\n` +
          `E correct?`
        : `🏦 *Bank Account Verification*\n\n` +
          `Please confirm your bank details for this sell:\n` +
          `- *Bank Name:* ${ctx.wizard.state.data.bankName}\n` +
          `- *Account Number:* \`${accountNumber}\`\n` +
          `- *Account Holder:* ${verificationResult.data.account_name}\n\n` +
          `Is this correct?`;
      await ctx.replyWithMarkdown(confirmMsg, Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes, Confirm', 'confirm_bank_yes')],
        [Markup.button.callback('❌ No, Edit Details', 'confirm_bank_no')],
        [Markup.button.callback('❌ Cancel Linking', 'cancel_bank_linking')]
      ]));
      return ctx.wizard.next();
    } catch (error) {
      logger.error(`Error verifying bank account for user ${ctx.wizard.state.data.userId}: ${error.message}`);
      const errorMsg = userState.usePidgin
        ? '❌ Bank verification fail. Check your details or try again:'
        : '❌ Bank verification failed. Check your details and try again:';
      await ctx.replyWithMarkdown(errorMsg);
      return;
    }
  },
  async (ctx) => {
    // Placeholder step for action handling
    return;
  }
);

// Action Handlers
bankLinkingSceneTemp.action('confirm_suggested_bank', async (ctx) => {
  const userState = await getUserState(ctx.wizard.state.data.userId);
  const suggestedBank = ctx.wizard.state.data.suggestedBank;

  ctx.wizard.state.data.bankName = suggestedBank.name;
  ctx.wizard.state.data.bankCode = suggestedBank.code;

  if (ctx.wizard.state.suggestionMessageId) {
    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, ctx.wizard.state.suggestionMessageId);
    } catch (error) {
      logger.error(`Failed to delete suggestion message: ${error.message}`);
    }
  }

  const prompt = userState.usePidgin
    ? '🔢 Enter your 10-digit account number:'
    : '🔢 Please enter your 10-digit account number:';
  await ctx.replyWithMarkdown(prompt);
  await ctx.answerCbQuery();
  ctx.wizard.selectStep(2);
});

bankLinkingSceneTemp.action('retry_bank_name', async (ctx) => {
  const userState = await getUserState(ctx.wizard.state.data.userId);

  if (ctx.wizard.state.suggestionMessageId) {
    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, ctx.wizard.state.suggestionMessageId);
    } catch (error) {
      logger.error(`Failed to delete suggestion message: ${error.message}`);
    }
  }

  const prompt = userState.usePidgin
    ? '🏦 Enter the correct bank name one more time (e.g., GTBank, Access):'
    : '🏦 Please enter the correct bank name one more time (e.g., GTBank, Access):';
  await ctx.replyWithMarkdown(prompt);
  await ctx.answerCbQuery();
  ctx.wizard.selectStep(1);
});

bankLinkingSceneTemp.action('confirm_bank_yes', async (ctx) => {
  const userId = ctx.wizard.state.data.userId;
  const userState = await getUserState(userId);
  const bankDetails = ctx.wizard.state.data.bankDetails;

  const confirmMsg = userState.usePidgin
    ? `✅ *Bank Linked for This Sell*\n\n` +
      `- *Bank Name:* ${bankDetails.bankName}\n` +
      `- *Account Number:* \`${bankDetails.accountNumber}\`\n` +
      `- *Account Holder:* ${bankDetails.accountName}\n` +
      `- *Relay Address:* \`${bankDetails.relayAddress}\`\n\n` +
      `We go use this for your sell.`
    : `✅ *Bank Linked for This Sell*\n\n` +
      `- *Bank Name:* ${bankDetails.bankName}\n` +
      `- *Account Number:* \`${bankDetails.accountNumber}\`\n` +
      `- *Account Holder:* ${bankDetails.accountName}\n` +
      `- *Relay Address:* \`${bankDetails.relayAddress}\`\n\n` +
      `This will be used for your sell transaction.`;
  await ctx.replyWithMarkdown(confirmMsg);

  // Pass bankDetails back to sellScene
  ctx.scene.state.bankDetails = bankDetails;
  await ctx.answerCbQuery();
  return ctx.scene.leave();
});

bankLinkingSceneTemp.action('confirm_bank_no', async (ctx) => {
  const userState = await getUserState(ctx.wizard.state.data.userId);
  const retryMsg = userState.usePidgin
    ? '⚠️ Let’s start over. Enter your bank name again (e.g., GTBank, Access):'
    : '⚠️ Let’s try again. Please enter your bank name again (e.g., GTBank, Access):';
  await ctx.replyWithMarkdown(retryMsg);
  ctx.wizard.state.data = { userId: ctx.wizard.state.data.userId };
  await ctx.answerCbQuery();
  ctx.wizard.selectStep(1);
});

bankLinkingSceneTemp.action('cancel_bank_linking', async (ctx) => {
  const userState = await getUserState(ctx.wizard.state.data.userId);
  const cancelMsg = userState.usePidgin
    ? '❌ Bank linking don cancel. Sell no go continue.'
    : '❌ Bank linking cancelled. Sell transaction aborted.';
  await ctx.replyWithMarkdown(cancelMsg);
  await ctx.answerCbQuery();
  return ctx.scene.leave();
});

// Handle scene exit to return to sellScene
bankLinkingSceneTemp.leave(async (ctx) => {
  if (ctx.wizard.state.data.bankDetails) {
    ctx.scene.state.bankDetails = ctx.wizard.state.data.bankDetails;
    await ctx.scene.enter('sell_scene', { step: 3 }); // Return to sellScene step 3
  } else {
    await ctx.reply('Sell process ended due to no bank linked.');
  }
});

module.exports = bankLinkingSceneTemp;
