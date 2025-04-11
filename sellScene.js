// sellScene.js
const { Scenes, Markup } = require('telegraf');
const axios = require('axios');
const ethers = require('ethers');

const sellScene = new Scenes.WizardScene(
  'sell_scene',
  // Step 1: Parse and Validate Input
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const userState = await ctx.getUserState(userId);
    const input = ctx.message.text.replace('/sell', '').trim().split(/\s+/);

    if (input.length < 3) {
      const errorMsg = userState.usePidgin
        ? '❌ Format no correct. Use: /sell <amount> <asset/address> <chain>'
        : '❌ Invalid format. Use: /sell <amount> <asset/address> <chain>';
      await ctx.replyWithMarkdown(errorMsg);
      return ctx.scene.leave();
    }

    const [amountStr, assetInput, chain] = input;
    const amount = parseFloat(amountStr);
    if (isNaN(amount) || amount <= 0) {
      const errorMsg = userState.usePidgin
        ? '❌ Amount no valid. Enter correct number.'
        : '❌ Invalid amount. Please enter a valid number.';
      await ctx.replyWithMarkdown(errorMsg);
      return ctx.scene.leave();
    }

    ctx.wizard.state.userId = userId;
    ctx.wizard.state.amount = amount;
    ctx.wizard.state.assetInput = assetInput;
    ctx.wizard.state.chain = chain.toLowerCase();

    await ctx.replyWithMarkdown(userState.usePidgin
      ? '🔄 Dey check your asset and chain...'
      : '🔄 Verifying your asset and chain...');

    try {
      const chainId = mapChainToId(ctx.wizard.state.chain);
      if (!chainId) throw new Error('Unsupported chain');

      let assets;
      if (ethers.utils.isAddress(assetInput)) {
        assets = await validateAssetByAddress(ctx.wizard.state.assetInput, chainId, ctx.relayClient);
      } else {
        assets = await validateAssetByTerm(ctx.wizard.state.assetInput, chainId, ctx.relayClient);
      }

      if (!assets || assets.length === 0) {
        const errorMsg = userState.usePidgin
          ? '❌ No asset match your input for this chain. Try again.'
          : '❌ No matching assets found for this chain. Please try again.';
        await ctx.replyWithMarkdown(errorMsg);
        return ctx.scene.leave();
      }

      ctx.wizard.state.validatedAssets = assets;
      if (assets.length > 1) {
        const options = assets.map((asset, index) => [
          Markup.button.callback(`${asset.symbol} - ${asset.name} (${asset.address.slice(0, 6)}...)`, `select_asset_${index}`)
        ]);
        await ctx.replyWithMarkdown(userState.usePidgin
          ? '🤔 Multiple assets dey. Pick the one you want:'
          : '🤔 Multiple assets found. Please select the one you intend to sell:', Markup.inlineKeyboard(options));
        return ctx.wizard.next();
      } else {
        ctx.wizard.state.selectedAsset = assets[0];
        return ctx.wizard.selectStep(2); // Skip to bank selection
      }
    } catch (error) {
      ctx.logger.error(`Error validating asset for user ${userId}: ${error.message}`);
      const errorMsg = userState.usePidgin
        ? '❌ Error checking asset. Try again or contact [@maxcswap](https://t.me/maxcswap).'
        : '❌ Error verifying asset. Try again or contact [@maxcswap](https://t.me/maxcswap).';
      await ctx.replyWithMarkdown(errorMsg);
      return ctx.scene.leave();
    }
  },
  // Step 2: Select Asset (if multiple)
  async (ctx) => {
    // Handled by action below
  },
  // Step 3: Bank Selection
  async (ctx) => {
    const userId = ctx.wizard.state.userId;
    const userState = await ctx.getUserState(userId);
    const walletsWithBank = userState.wallets.filter(w => w.bank);

    if (!ctx.wizard.state.selectedAsset) {
      const errorMsg = userState.usePidgin
        ? '❌ No asset selected. Start again with /sell.'
        : '❌ No asset selected. Please start over with /sell.';
      await ctx.replyWithMarkdown(errorMsg);
      return ctx.scene.leave();
    }

    const asset = ctx.wizard.state.selectedAsset;
    const amountInWei = ethers.utils.parseUnits(ctx.wizard.state.amount.toString(), asset.decimals).toString();

    ctx.wizard.state.amountInWei = amountInWei;

    if (walletsWithBank.length === 0) {
      const prompt = userState.usePidgin
        ? '🏦 No bank linked yet. You wan link one for this sell?'
        : '🏦 No bank linked yet. Would you like to link one for this sell?';
      await ctx.replyWithMarkdown(prompt, Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes', 'link_temp_bank')],
        [Markup.button.callback('❌ No', 'cancel_sell')]
      ]));
      return ctx.wizard.next();
    }

    const bankOptions = walletsWithBank.map((wallet, index) => [
      Markup.button.callback(`${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)})`, `select_bank_${index}`)
    ]);
    bankOptions.push([Markup.button.callback('➕ Use Another Bank', 'link_temp_bank')]);

    const assetMsg = userState.usePidgin
      ? `✅ *Asset Confirmed*\n\n` +
        `*Symbol:* ${asset.symbol}\n` +
        `*Name:* ${asset.name}\n` +
        `*Address:* \`${asset.address}\`\n` +
        `*Chain:* ${ctx.wizard.state.chain}\n\n` +
        `Where you want the funds go?`
      : `✅ *Asset Confirmed*\n\n` +
        `*Symbol:* ${asset.symbol}\n` +
        `*Name:* ${asset.name}\n` +
        `*Address:* \`${asset.address}\`\n` +
        `*Chain:* ${ctx.wizard.state.chain}\n\n` +
        `Where would you like to receive the funds?`;
    await ctx.replyWithMarkdown(assetMsg, Markup.inlineKeyboard(bankOptions));
    return ctx.wizard.next();
  },
  // Step 4: Confirm Bank and Proceed to Quote
  async (ctx) => {
    // Handled by actions below
  },
  // Step 5: Fetch Quote and Execute with Privy
  async (ctx) => {
    const userId = ctx.wizard.state.userId;
    const userState = await ctx.getUserState(userId);
    const asset = ctx.wizard.state.selectedAsset;
    const bankDetails = ctx.wizard.state.bankDetails;

    if (!bankDetails) {
      const errorMsg = userState.usePidgin
        ? '❌ No bank selected. Start again with /sell.'
        : '❌ No bank selected. Please start over with /sell.';
      await ctx.replyWithMarkdown(errorMsg);
      return ctx.scene.leave();
    }

    await ctx.replyWithMarkdown(userState.usePidgin
      ? '🔗 Connect your wallet now to sell. Follow the link below:'
      : '🔗 Please connect your wallet to proceed with the sell. Follow the link below:');
    const connectUrl = `${ctx.webhookDomain}/connect?userId=${userId}&sessionId=${ctx.wizard.state.sessionId}`;
    await ctx.replyWithMarkdown(`[Connect Wallet](${connectUrl})`);

    // Store session in Firestore
    await ctx.db.collection('sessions').doc(ctx.wizard.state.sessionId).set({
      userId,
      amountInWei: ctx.wizard.state.amountInWei,
      token: asset.address,
      chainId: asset.chainId,
      bankDetails,
      status: 'pending',
      createdAt: new Date().toISOString()
    });

    return ctx.wizard.next();
  },
  // Step 6: Wait for Wallet Connection and Execute
  async (ctx) => {
    // This step waits for client-side execution via Privy
  }
);

// Helper Functions
function mapChainToId(chain) {
  const chainMap = {
    'eth': 1,
    'ethereum': 1,
    'polygon': 137,
    'bnb': 56,
    'base': 8453,
    // Add more EVM chains as needed
  };
  return chainMap[chain.toLowerCase()];
}

async function validateAssetByAddress(address, chainId, relayClient) {
  try {
    const response = await axios.post('https://api.relay.link/currencies/v1', {
      chainIds: [chainId],
      term: address,
      verified: true,
      limit: 10,
      includeAllChains: false,
      useExternalSearch: true,
      depositAddressOnly: true
    }, { headers: { 'Content-Type': 'application/json' } });
    return response.data.flat();
  } catch (error) {
    throw new Error(`Address validation failed: ${error.message}`);
  }
}

async function validateAssetByTerm(term, chainId, relayClient) {
  try {
    const response = await axios.post('https://api.relay.link/currencies/v1', {
      chainIds: [chainId],
      term,
      verified: true,
      limit: 10,
      includeAllChains: false,
      useExternalSearch: true,
      depositAddressOnly: true
    }, { headers: { 'Content-Type': 'application/json' } });
    return response.data.flat();
  } catch (error) {
    throw new Error(`Term validation failed: ${error.message}`);
  }
}

async function fetchRelayQuote(userAddress, originChainId, originCurrency, amount, recipient, relayClient) {
  try {
    const quotePayload = {
      user: userAddress,
      originChainId,
      originCurrency,
      destinationChainId: 8453, // Base chain
      destinationCurrency: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
      tradeType: 'EXACT_INPUT',
      recipient,
      amount,
      refundTo: userAddress
    };
    const response = await axios.post('https://api.relay.link/quote', quotePayload, {
      headers: { 'Content-Type': 'application/json' }
    });
    return response.data;
  } catch (error) {
    throw new Error(`Failed to fetch Relay quote: ${error.message}`);
  }
}

// Actions
sellScene.action(/select_asset_(\d+)/, async (ctx) => {
  const index = parseInt(ctx.match[1], 10);
  const userState = await ctx.getUserState(ctx.wizard.state.userId);
  const assets = ctx.wizard.state.validatedAssets;

  if (index >= 0 && index < assets.length) {
    ctx.wizard.state.selectedAsset = assets[index];
    await ctx.answerCbQuery();
    return ctx.wizard.selectStep(2);
  } else {
    await ctx.replyWithMarkdown(userState.usePidgin
      ? '❌ Asset no valid. Pick again.'
      : '❌ Invalid asset selection. Please try again.');
    await ctx.answerCbQuery();
  }
});

sellScene.action(/select_bank_(\d+)/, async (ctx) => {
  const index = parseInt(ctx.match[1], 10);
  const userId = ctx.wizard.state.userId;
  const userState = await ctx.getUserState(userId);
  const walletsWithBank = userState.wallets.filter(w => w.bank);

  if (index >= 0 && index < walletsWithBank.length) {
    ctx.wizard.state.bankDetails = walletsWithBank[index].bank;
    ctx.wizard.state.sessionId = uuidv4();
    const confirmMsg = userState.usePidgin
      ? `🏦 You go receive funds to:\n` +
        `*Bank:* ${ctx.wizard.state.bankDetails.bankName}\n` +
        `*Account:* ****${ctx.wizard.state.bankDetails.accountNumber.slice(-4)}\n` +
        `*Name:* ${ctx.wizard.state.bankDetails.accountName}\n\n` +
        `E correct?`
      : `🏦 Funds will be sent to:\n` +
        `*Bank:* ${ctx.wizard.state.bankDetails.bankName}\n` +
        `*Account:* ****${ctx.wizard.state.bankDetails.accountNumber.slice(-4)}\n` +
        `*Name:* ${ctx.wizard.state.bankDetails.accountName}\n\n` +
        `Is this correct?`;
    await ctx.replyWithMarkdown(confirmMsg, Markup.inlineKeyboard([
      [Markup.button.callback('✅ Yes', 'confirm_bank')],
      [Markup.button.callback('❌ No', 'cancel_sell')]
    ]));
    await ctx.answerCbQuery();
  }
});

sellScene.action('link_temp_bank', async (ctx) => {
  await ctx.scene.enter('bank_linking_scene_temp');
  ctx.wizard.state.awaitingTempBank = true;
  await ctx.answerCbQuery();
});

sellScene.action('confirm_bank', async (ctx) => {
  const userId = ctx.wizard.state.userId;
  const userState = await ctx.getUserState(userId);
  await ctx.replyWithMarkdown(userState.usePidgin
    ? '🔄 Dey fetch quote for your sell...'
    : '🔄 Fetching quote for your sell...');
  
  const asset = ctx.wizard.state.selectedAsset;
  const blockradarWallet = userState.wallets[0].address; // Assuming first wallet for simplicity

  try {
    const quote = await fetchRelayQuote(
      '0xUserWalletPlaceholder', // Will be updated client-side
      asset.chainId,
      asset.address,
      ctx.wizard.state.amountInWei,
      blockradarWallet,
      ctx.relayClient
    );

    ctx.wizard.state.quote = quote;
    ctx.wizard.state.sessionId = uuidv4();

    const amountInUSD = ctx.wizard.state.amount * 1; // Assume 1:1 for simplicity, adjust with real rates
    const amountOut = ethers.utils.formatUnits(quote.amountOut, 6); // USDC decimals
    const fees = ethers.utils.formatEther(quote.feeDetails.totalFee);
    const slippage = quote.slippage || '0.5%';

    const quoteMsg = userState.usePidgin
      ? `📊 *Sell Quote*\n\n` +
        `*Amount In:* ${ctx.wizard.state.amount} ${asset.symbol} (~$${amountInUSD})\n` +
        `*Amount Out:* ${amountOut} USDC\n` +
        `*Fees:* ${fees} ETH\n` +
        `*Slippage:* ${slippage}\n\n` +
        `Ready to connect wallet and sell?`
      : `📊 *Sell Quote*\n\n` +
        `*Amount In:* ${ctx.wizard.state.amount} ${asset.symbol} (~$${amountInUSD})\n` +
        `*Amount Out:* ${amountOut} USDC\n` +
        `*Fees:* ${fees} ETH\n` +
        `*Slippage:* ${slippage}\n\n` +
        `Ready to connect your wallet and proceed?`;
    await ctx.replyWithMarkdown(quoteMsg);
    return ctx.wizard.selectStep(4);
  } catch (error) {
    ctx.logger.error(`Error fetching quote for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown(userState.usePidgin
      ? '❌ Error fetching quote. Try again.'
      : '❌ Failed to fetch quote. Please try again.');
    return ctx.scene.leave();
  }
});

sellScene.action('cancel_sell', async (ctx) => {
  const userState = await ctx.getUserState(ctx.wizard.state.userId);
  await ctx.replyWithMarkdown(userState.usePidgin
    ? '❌ Sell cancelled.'
    : '❌ Sell process cancelled.');
  await ctx.answerCbQuery();
  return ctx.scene.leave();
});

// Setup Function
function setup(bot, db, logger, getUserState, updateUserState, relayClient, privyClient, exchangeRates, chains) {
  sellScene.getUserState = getUserState;
  sellScene.db = db;
  sellScene.logger = logger;
  sellScene.relayClient = relayClient;
  sellScene.privyClient = privyClient;
  sellScene.exchangeRates = exchangeRates;
  sellScene.chains = chains;
  sellScene.webhookDomain = process.env.WEBHOOK_DOMAIN;

  // Handle temp bank linking completion
  bot.on('callback_query', async (ctx) => {
    if (ctx.scene.current?.id === 'bank_linking_scene_temp' && ctx.wizard.state.awaitingTempBank) {
      if (ctx.callbackQuery.data === 'confirm_bank_temp') {
        ctx.wizard.state.bankDetails = ctx.scene.state.bankDetails;
        ctx.wizard.state.sessionId = uuidv4();
        await ctx.wizard.selectStep(4); // Proceed to quote fetching
      }
    }
  });
}

module.exports = { sellScene, setup };
