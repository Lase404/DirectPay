const { Scenes, Markup } = require('telegraf');
const axios = require('axios');
const ethers = require('ethers');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const sellScene = new Scenes.WizardScene(
  'sell_scene',
  // Step 0: Parse and Validate Input
  async (ctx) => {
    const userId = ctx.from.id.toString();
    ctx.session.wizardState = ctx.session.wizardState || {};
    ctx.session.wizardState.userId = userId;

    let userState;
    try {
      userState = await sellScene.getUserState(userId);
      if (!userState) throw new Error('User state not found');
    } catch (err) {
      sellScene.logger.error(`Failed to fetch user state for user ${userId}: ${err.message}`);
      await ctx.replyWithMarkdown(
        '❌ Error fetching your profile. Please try again or contact [@maxcswap](https://t.me/maxcswap).',
        Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]])
      );
      return ctx.scene.leave();
    }

    sellScene.logger.info(`User ${userId} entered sell scene with input: ${ctx.message?.text || 'unknown'}`);

    const input = ctx.message?.text?.replace('/sell', '').trim().split(/\s+/);
    if (!input || input.length < 3) {
      const errorMsg = userState.usePidgin
        ? '❌ Format no correct. Use: /sell <amount> <asset/address> <chain>\nE.g., /sell 100 USDC eth'
        : '❌ Invalid format. Use: /sell <amount> <asset/address> <chain>\nE.g., /sell 100 USDC eth';
      await ctx.replyWithMarkdown(
        errorMsg,
        Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]])
      );
      return ctx.scene.leave();
    }

    const [amountStr, assetInput, chain] = input;
    const amount = parseFloat(amountStr);
    if (isNaN(amount) || amount <= 0) {
      const errorMsg = userState.usePidgin
        ? '❌ Amount no valid. Enter correct number like 100 or 0.5.'
        : '❌ Invalid amount. Please enter a valid number like 100 or 0.5.';
      await ctx.replyWithMarkdown(
        errorMsg,
        Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]])
      );
      return ctx.scene.leave();
    }

    ctx.session.wizardState = {
      userId,
      amount,
      assetInput,
      chain: chain.toLowerCase(),
      stepStartedAt: Date.now(),
    };

    await ctx.replyWithMarkdown(
      userState.usePidgin
        ? '🔄 Dey check your asset and chain... E fit take small time.'
        : '🔄 Verifying your asset and chain... This may take a moment.'
    );

    try {
      const chainId = mapChainToId(ctx.session.wizardState.chain);
      if (!chainId) {
        throw new Error(`Unsupported chain: ${ctx.session.wizardState.chain}. Supported: eth, base, bnb, polygon`);
      }

      let assets;
      if (ethers.utils.isAddress(assetInput)) {
        assets = await validateAssetByAddress(assetInput, chainId, sellScene.relayClient);
      } else {
        assets = await validateAssetByTerm(assetInput, chainId, sellScene.relayClient);
      }

      if (!assets || assets.length === 0) {
        const errorMsg = userState.usePidgin
          ? '❌ No asset match your input for this chain. Check the symbol or address and try again.'
          : '❌ No matching assets found for this chain. Verify the symbol or address and try again.';
        await ctx.replyWithMarkdown(
          errorMsg,
          Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]])
        );
        return ctx.scene.leave();
      }

      ctx.session.wizardState.validatedAssets = assets;
      if (assets.length > 1) {
        const options = assets.map((asset, index) => [
          Markup.button.callback(
            `${asset.symbol} - ${asset.name} (${asset.address.slice(0, 6)}...)`,
            `select_asset_${index}`
          ),
        ]);
        options.push([Markup.button.callback('❌ Cancel', 'cancel_sell')]);
        await ctx.replyWithMarkdown(
          userState.usePidgin
            ? '🤔 Multiple assets dey. Pick the one you want (Step 1/4):'
            : '🤔 Multiple assets found. Please select one (Step 1/4):',
          Markup.inlineKeyboard(options)
        );
        sellScene.logger.info(`User ${userId} prompted to select asset from ${assets.length} options`);
        return;
      } else {
        ctx.session.wizardState.selectedAsset = assets[0];
        ctx.session.wizardState.amount = amount;
        sellScene.logger.info(`User ${userId} auto-selected single asset: ${assets[0].symbol}`);
        await promptBankSelection(ctx);
        return;
      }
    } catch (error) {
      sellScene.logger.error(`Error validating asset for user ${userId}: ${error.message}`);
      const errorMsg = userState.usePidgin
        ? `❌ Error checking asset: ${error.message}. Try again or contact [@maxcswap](https://t.me/maxcswap).`
        : `❌ Error verifying asset: ${error.message}. Try again or contact [@maxcswap](https://t.me/maxcswap).`;
      await ctx.replyWithMarkdown(
        errorMsg,
        Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]])
      );
      return ctx.scene.leave();
    }
  },
  // Step 1: Handle Unexpected Messages
  async (ctx) => {
    await ctx.replyWithMarkdown('Please use the buttons to proceed.');
    return;
  }
);

// Helper Functions
function mapChainToId(chain) {
  const chainMap = {
    eth: 1,
    ethereum: 1,
    base: 8453,
    bnb: 56,
    bsc: 56,
    polygon: 137,
    matic: 137,
  };
  return chainMap[chain.toLowerCase()];
}

async function validateAssetByAddress(address, chainId, relayClient, retries = 2) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      sellScene.logger.info(`Validating asset by address: ${address} on chainId: ${chainId}, attempt ${attempt}`);
      const response = await axios.post(
        'https://api.relay.link/currencies/v1',
        {
          chainIds: [chainId],
          term: address,
          verified: true,
          limit: 10,
          includeAllChains: false,
          useExternalSearch: true,
          depositAddressOnly: true,
        },
        { headers: { 'Content-Type': 'application/json' } }
      );
      return response.data.flat();
    } catch (error) {
      sellScene.logger.error(`Address validation failed for address ${address}, attempt ${attempt}: ${error.message}`);
      if (attempt === retries) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

async function validateAssetByTerm(term, chainId, relayClient, retries = 2) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      sellScene.logger.info(`Validating asset by term: ${term} on chainId: ${chainId}, attempt ${attempt}`);
      const response = await axios.post(
        'https://api.relay.link/currencies/v1',
        {
          chainIds: [chainId],
          term,
          verified: true,
          limit: 10,
          includeAllChains: false,
          useExternalSearch: true,
          depositAddressOnly: true,
        },
        { headers: { 'Content-Type': 'application/json' } }
      );
      return response.data.flat();
    } catch (error) {
      sellScene.logger.error(`Term validation failed for term ${term}, attempt ${attempt}: ${error.message}`);
      if (attempt === retries) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

function generateSessionHash(sessionData) {
  const secret = process.env.SESSION_SECRET || 'your-secret-key';
  const dataString = `${sessionData.sessionId}:${sessionData.amountInWei}:${sessionData.token}:${sessionData.chainId}:${sessionData.blockradarWallet}`;
  return crypto.createHmac('sha256', secret).update(dataString).digest('hex');
}

async function promptBankSelection(ctx) {
  const userId = ctx.session.wizardState.userId;
  let userState;
  try {
    userState = await sellScene.getUserState(userId);
    if (!userState) throw new Error('User state not found');
  } catch (err) {
    sellScene.logger.error(`Failed to fetch user state for user ${userId}: ${err.message}`);
    await ctx.replyWithMarkdown(
      '❌ Error fetching your profile. Please try again or contact [@maxcswap](https://t.me/maxcswap).',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]])
    );
    return ctx.scene.leave();
  }

  const walletsWithBank = userState.wallets?.filter((w) => w.bank) || [];
  const asset = ctx.session.wizardState.selectedAsset;
  const amount = ctx.session.wizardState.amount;

  sellScene.logger.info(`Prompting bank selection for user ${userId}: asset=${!!asset}, amount=${amount}`);

  if (!asset || !amount) {
    sellScene.logger.error(`Missing asset or amount for user ${userId}: asset=${!!asset}, amount=${!!amount}`);
    await ctx.replyWithMarkdown(
      userState.usePidgin
        ? '❌ No asset or amount selected. Start again with /sell.'
        : '❌ No asset or amount selected. Please start over with /sell.',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]])
    );
    return ctx.scene.leave();
  }

  if (walletsWithBank.length === 0) {
    const prompt = userState.usePidgin
      ? '🏦 No bank linked yet. You wan link one for this sell? (Step 2/4)'
      : '🏦 No bank linked yet. Would you like to link one for this sell? (Step 2/4)';
    await ctx.replyWithMarkdown(
      prompt,
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes', 'link_temp_bank')],
        [Markup.button.callback('❌ Cancel', 'cancel_sell')],
      ])
    );
    sellScene.logger.info(`User ${userId} prompted to link bank (no banks linked)`);
  } else {
    const bankOptions = walletsWithBank.map((wallet, index) => [
      Markup.button.callback(
        `${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)})`,
        `select_bank_${index}`
      ),
    ]);
    bankOptions.push([Markup.button.callback('➕ Use Another Bank', 'link_temp_bank')]);
    bankOptions.push([Markup.button.callback('❌ Cancel', 'cancel_sell')]);

    const assetMsg = userState.usePidgin
      ? `✅ *Asset Confirmed* (Step 2/4)\n\n` +
        `*Symbol:* ${asset.symbol}\n` +
        `*Name:* ${asset.name}\n` +
        `*Address:* \`${asset.address}\`\n` +
        `*Chain:* ${ctx.session.wizardState.chain}\n` +
        `*Amount:* ${amount} ${asset.symbol}\n\n` +
        `Where you want the funds go?`
      : `✅ *Asset Confirmed* (Step 2/4)\n\n` +
        `*Symbol:* ${asset.symbol}\n` +
        `*Name:* ${asset.name}\n` +
        `*Address:* \`${asset.address}\`\n` +
        `*Chain:* ${ctx.session.wizardState.chain}\n` +
        `*Amount:* ${amount} ${asset.symbol}\n\n` +
        `Where would you like to receive the funds?`;
    await ctx.replyWithMarkdown(assetMsg, Markup.inlineKeyboard(bankOptions));
    sellScene.logger.info(`User ${userId} prompted to select bank from ${walletsWithBank.length} options`);
  }
}

// Action Handlers
sellScene.action(/select_asset_(\d+)/, async (ctx) => {
  const userId = ctx.session.wizardState.userId;
  let userState;
  try {
    userState = await sellScene.getUserState(userId);
    if (!userState) throw new Error('User state not found');
  } catch (err) {
    sellScene.logger.error(`Failed to fetch user state for user ${userId}: ${err.message}`);
    await ctx.replyWithMarkdown(
      '❌ Error fetching your profile. Please try again or contact [@maxcswap](https://t.me/maxcswap).',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]])
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  const index = parseInt(ctx.match[1], 10);
  const assets = ctx.session.wizardState.validatedAssets;
  if (!assets || index < 0 || index >= assets.length) {
    await ctx.replyWithMarkdown(
      userState.usePidgin
        ? '❌ Asset no valid. Pick again or cancel.'
        : '❌ Invalid asset selection. Try again or cancel.',
      Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'cancel_sell')]])
    );
    await ctx.answerCbQuery();
    return;
  }

  ctx.session.wizardState.selectedAsset = assets[index];
  await ctx.answerCbQuery();
  await ctx.replyWithMarkdown(
    userState.usePidgin
      ? `✅ Asset selected: ${assets[index].symbol}!`
      : `✅ Asset selected: ${assets[index].symbol}!`
  );
  sellScene.logger.info(`User ${userId} selected asset: ${assets[index].symbol}`);
  await promptBankSelection(ctx);
});

sellScene.action(/select_bank_(\d+)/, async (ctx) => {
  const userId = ctx.session.wizardState.userId;
  let userState;
  try {
    userState = await sellScene.getUserState(userId);
    if (!userState) throw new Error('User state not found');
  } catch (err) {
    sellScene.logger.error(`Failed to fetch user state for user ${userId}: ${err.message}`);
    await ctx.replyWithMarkdown(
      '❌ Error fetching your profile. Please try again or contact [@maxcswap](https://t.me/maxcswap).',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]])
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  sellScene.logger.info(`Selecting bank for user ${userId}: asset=${!!ctx.session.wizardState.selectedAsset}, amount=${ctx.session.wizardState.amount}`);

  if (!ctx.session.wizardState.selectedAsset || !ctx.session.wizardState.amount) {
    sellScene.logger.error(`Missing asset or amount for user ${userId}: asset=${!!ctx.session.wizardState.selectedAsset}, amount=${!!ctx.session.wizardState.amount}`);
    await ctx.replyWithMarkdown(
      userState.usePidgin
        ? '❌ No asset or amount selected. Start again with /sell.'
        : '❌ No asset or amount selected. Please start over with /sell.',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]])
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  const index = parseInt(ctx.match[1], 10);
  const walletsWithBank = userState.wallets?.filter((w) => w.bank) || [];
  if (index < 0 || index >= walletsWithBank.length) {
    await ctx.replyWithMarkdown(
      userState.usePidgin
        ? '❌ Bank no valid. Pick again or cancel.'
        : '❌ Invalid bank selection. Try again or cancel.',
      Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'cancel_sell')]])
    );
    await ctx.answerCbQuery();
    return;
  }

  ctx.session.wizardState.bankDetails = walletsWithBank[index].bank;
  ctx.session.wizardState.selectedWalletAddress = walletsWithBank[index].address;

  const confirmMsg = userState.usePidgin
    ? `🏦 Funds go enter:\n` +
      `*Bank:* ${ctx.session.wizardState.bankDetails.bankName}\n` +
      `*Account:* ****${ctx.session.wizardState.bankDetails.accountNumber.slice(-4)}\n` +
      `*Name:* ${ctx.session.wizardState.bankDetails.accountName}\n\n` +
      `E correct? (Step 3/4)`
    : `🏦 Funds will be sent to:\n` +
      `*Bank:* ${ctx.session.wizardState.bankDetails.bankName}\n` +
      `*Account:* ****${ctx.session.wizardState.bankDetails.accountNumber.slice(-4)}\n` +
      `*Name:* ${ctx.session.wizardState.bankDetails.accountName}\n\n` +
      `Is this correct? (Step 3/4)`;
  await ctx.replyWithMarkdown(
    confirmMsg,
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ Yes', 'confirm_bank')],
      [Markup.button.callback('❌ Cancel', 'cancel_sell')],
    ])
  );
  await ctx.answerCbQuery();
  sellScene.logger.info(`User ${userId} selected bank, awaiting confirmation`);
});

sellScene.action('confirm_bank', async (ctx) => {
  const userId = ctx.session.wizardState.userId;
  let userState;
  try {
    userState = await sellScene.getUserState(userId);
    if (!userState) throw new Error('User state not found');
  } catch (err) {
    sellScene.logger.error(`Failed to fetch user state for user ${userId}: ${err.message}`);
    await ctx.replyWithMarkdown(
      '❌ Error fetching your profile. Please try again or contact [@maxcswap](https://t.me/maxcswap).',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]])
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  sellScene.logger.info(`Confirming bank for user ${userId}: asset=${!!ctx.session.wizardState.selectedAsset}, amount=${ctx.session.wizardState.amount}`);

  const { selectedAsset: asset, bankDetails, selectedWalletAddress, amount } = ctx.session.wizardState;
  if (!asset || !bankDetails || !selectedWalletAddress || !amount) {
    sellScene.logger.error(`Missing details for user ${userId}: asset=${!!asset}, bankDetails=${!!bankDetails}, walletAddress=${!!selectedWalletAddress}, amount=${!!amount}`);
    const errorMsg = userState.usePidgin
      ? '❌ Something miss for your sell. Start again with /sell.'
      : '❌ Missing details for your sell. Please start over with /sell.';
    await ctx.replyWithMarkdown(
      errorMsg,
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]])
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  let amountInWei;
  try {
    amountInWei = ethers.utils.parseUnits(amount.toString(), asset.decimals).toString();
  } catch (error) {
    sellScene.logger.error(`Error parsing amount for user ${userId}: ${error.message}`);
    const errorMsg = userState.usePidgin
      ? '❌ Amount no valid for this asset. Start again with /sell.'
      : '❌ Invalid amount for this asset. Please start over with /sell.';
    await ctx.replyWithMarkdown(
      errorMsg,
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]])
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  ctx.session.wizardState.amountInWei = amountInWei;
  ctx.session.wizardState.sessionId = uuidv4();

  const sessionData = {
    userId,
    amountInWei,
    token: asset.address,
    chainId: mapChainToId(ctx.session.wizardState.chain),
    bankDetails,
    blockradarWallet: selectedWalletAddress,
    status: 'pending',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  };

  try {
    await sellScene.db.collection('sessions').doc(ctx.session.wizardState.sessionId).set(sessionData);
    sellScene.logger.info(`Session stored for user ${userId}, sessionId: ${ctx.session.wizardState.sessionId}`);
  } catch (error) {
    sellScene.logger.error(`Failed to store session for user ${userId}: ${error.message}`);
    const errorMsg = userState.usePidgin
      ? '❌ Error saving your sell details. Try again or contact [@maxcswap](https://t.me/maxcswap).'
      : '❌ Error saving your sell details. Try again or contact [@maxcswap](https://t.me/maxcswap).';
    await ctx.replyWithMarkdown(
      errorMsg,
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]])
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  const sessionHash = generateSessionHash({
    sessionId: ctx.session.wizardState.sessionId,
    amountInWei,
    token: asset.address,
    chainId: sessionData.chainId,
    blockradarWallet: selectedWalletAddress,
  });

  const webhookDomain = sellScene.webhookDomain || 'https://fallback-domain.com';
  const connectUrl = `${webhookDomain}/connect?sessionId=${ctx.session.wizardState.sessionId}&hash=${sessionHash}`;

  const confirmMsg = userState.usePidgin
    ? `📝 *Sell Details* (Step 4/4)\n\n` +
      `*Amount:* ${amount} ${asset.symbol}\n` +
      `*Chain:* ${ctx.session.wizardState.chain}\n` +
      `*Bank:* ${bankDetails.bankName} (****${bankDetails.accountNumber.slice(-4)})\n\n` +
      `Connect your wallet now!`
    : `📝 *Sell Details* (Step 4/4)\n\n` +
      `*Amount:* ${amount} ${asset.symbol}\n` +
      `*Chain:* ${ctx.session.wizardState.chain}\n` +
      `*Bank:* ${bankDetails.bankName} (****${bankDetails.accountNumber.slice(-4)})\n\n` +
      `Connect your wallet now!`;
  await ctx.replyWithMarkdown(confirmMsg);

  await ctx.replyWithMarkdown(
    `[Connect Wallet](${connectUrl})`,
    Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'cancel_sell')]])
  );
  sellScene.logger.info(`User ${userId} prompted to connect wallet: ${connectUrl}`);
  await ctx.answerCbQuery();
  return ctx.scene.leave();
});

sellScene.action('link_temp_bank', async (ctx) => {
  const userId = ctx.session.wizardState.userId;
  sellScene.logger.info(`User ${userId} chose to link a temporary bank`);
  if (!ctx.session.wizardState.selectedAsset || !ctx.session.wizardState.amount) {
    sellScene.logger.error(`Missing asset or amount for user ${userId} in link_temp_bank: asset=${!!ctx.session.wizardState.selectedAsset}, amount=${!!ctx.session.wizardState.amount}`);
    await ctx.replyWithMarkdown(
      '❌ No asset or amount selected. Please start over with /sell.',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]])
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }
  ctx.session.wizardState.awaitingTempBank = true;
  await ctx.scene.enter('bank_linking_scene_temp');
  await ctx.answerCbQuery();
});

sellScene.action('cancel_sell', async (ctx) => {
  await ctx.replyWithMarkdown('❌ Sell cancelled.');
  await ctx.answerCbQuery();
  return ctx.scene.leave();
});

sellScene.action('retry_sell', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.replyWithMarkdown('🔄 Restarting sell process. Use /sell to begin.');
  return ctx.scene.leave();
});

// Handle Temporary Bank Linking Completion
sellScene.action('confirm_bank_temp', async (ctx) => {
  const userId = ctx.session.wizardState.userId;
  let userState;
  try {
    userState = await sellScene.getUserState(userId);
    if (!userState) throw new Error('User state not found');
  } catch (err) {
    sellScene.logger.error(`Failed to fetch user state for user ${userId}: ${err.message}`);
    await ctx.replyWithMarkdown(
      '❌ Error fetching your profile. Please try again or contact [@maxcswap](https://t.me/maxcswap).',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]])
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  sellScene.logger.info(`Confirming temp bank for user ${userId}: asset=${!!ctx.session.wizardState.selectedAsset}, amount=${ctx.session.wizardState.amount}`);

  const { selectedAsset: asset, amount } = ctx.session.wizardState;
  const bankDetails = ctx.scene.state.bankDetails;
  const selectedWalletAddress = ctx.scene.state.walletAddress || ctx.session.wizardState.selectedWalletAddress;

  if (!asset || !bankDetails || !selectedWalletAddress || !amount) {
    sellScene.logger.error(`Missing details for user ${userId}: asset=${!!asset}, bankDetails=${!!bankDetails}, walletAddress=${!!selectedWalletAddress}, amount=${!!amount}`);
    const errorMsg = userState.usePidgin
      ? '❌ Something miss for your sell. Start again with /sell.'
      : '❌ Missing details for your sell. Please start over with /sell.';
    await ctx.replyWithMarkdown(
      errorMsg,
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]])
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  let amountInWei;
  try {
    amountInWei = ethers.utils.parseUnits(amount.toString(), asset.decimals).toString();
  } catch (error) {
    sellScene.logger.error(`Error parsing amount for user ${userId}: ${error.message}`);
    const errorMsg = userState.usePidgin
      ? '❌ Amount no valid for this asset. Start again with /sell.'
      : '❌ Invalid amount for this asset. Please start over with /sell.';
    await ctx.replyWithMarkdown(
      errorMsg,
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]])
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  ctx.session.wizardState.amountInWei = amountInWei;
  ctx.session.wizardState.sessionId = uuidv4();
  ctx.session.wizardState.bankDetails = bankDetails;
  ctx.session.wizardState.selectedWalletAddress = selectedWalletAddress;

  const sessionData = {
    userId,
    amountInWei,
    token: asset.address,
    chainId: mapChainToId(ctx.session.wizardState.chain),
    bankDetails,
    blockradarWallet: selectedWalletAddress,
    status: 'pending',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  };

  try {
    await sellScene.db.collection('sessions').doc(ctx.session.wizardState.sessionId).set(sessionData);
    sellScene.logger.info(`Session stored for user ${userId}, sessionId: ${ctx.session.wizardState.sessionId}`);
  } catch (error) {
    sellScene.logger.error(`Failed to store session for user ${userId}: ${error.message}`);
    const errorMsg = userState.usePidgin
      ? '❌ Error saving your sell details. Try again or contact [@maxcswap](https://t.me/maxcswap).'
      : '❌ Error saving your sell details. Try again or contact [@maxcswap](https://t.me/maxcswap).';
    await ctx.replyWithMarkdown(
      errorMsg,
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]])
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  const sessionHash = generateSessionHash({
    sessionId: ctx.session.wizardState.sessionId,
    amountInWei,
    token: asset.address,
    chainId: sessionData.chainId,
    blockradarWallet: selectedWalletAddress,
  });

  const webhookDomain = sellScene.webhookDomain || 'https://fallback-domain.com';
  const connectUrl = `${webhookDomain}/connect?sessionId=${ctx.session.wizardState.sessionId}&hash=${sessionHash}`;

  const confirmMsg = userState.usePidgin
    ? `📝 *Sell Details* (Step 4/4)\n\n` +
      `*Amount:* ${amount} ${asset.symbol}\n` +
      `*Chain:* ${ctx.session.wizardState.chain}\n` +
      `*Bank:* ${bankDetails.bankName} (****${bankDetails.accountNumber.slice(-4)})\n\n` +
      `Connect your wallet now!`
    : `📝 *Sell Details* (Step 4/4)\n\n` +
      `*Amount:* ${amount} ${asset.symbol}\n` +
      `*Chain:* ${ctx.session.wizardState.chain}\n` +
      `*Bank:* ${bankDetails.bankName} (****${bankDetails.accountNumber.slice(-4)})\n\n` +
      `Connect your wallet now!`;
  await ctx.replyWithMarkdown(confirmMsg);

  await ctx.replyWithMarkdown(
    `[Connect Wallet](${connectUrl})`,
    Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'cancel_sell')]])
  );
  sellScene.logger.info(`User ${userId} prompted to connect wallet: ${connectUrl}`);
  ctx.session.wizardState.awaitingTempBank = false;
  await ctx.answerCbQuery();
  return ctx.scene.leave();
});

// Setup Function
function setup(bot, db, logger, getUserState, relayClient) {
  sellScene.getUserState = getUserState;
  sellScene.db = db;
  sellScene.logger = logger;
  sellScene.relayClient = relayClient;
  sellScene.webhookDomain = process.env.WEBHOOK_DOMAIN;
}

module.exports = { sellScene, setup };
