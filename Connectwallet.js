import React, { useEffect } from 'react';
import { PrivyProvider, usePrivy, useConnectWallet, useWallets } from '@privy-io/react-auth';
import axios from 'axios';
import { ethers } from 'ethers';
import { useSearchParams } from 'react-router-dom';

function ConnectWalletApp() {
  return (
    <PrivyProvider appId={process.env.PRIVY_APP_ID}>
      <ConnectWallet />
    </PrivyProvider>
  );
}

function ConnectWallet() {
  const { ready, authenticated, getAccessToken } = usePrivy();
  const { connectWallet } = useConnectWallet();
  const { wallets } = useWallets();
  const [searchParams] = useSearchParams();
  const userId = searchParams.get('userId');

  useEffect(() => {
    if (ready && !authenticated) {
      connectWallet();
    }
    if (ready && authenticated && wallets.length) {
      handleWalletConnected();
    }
  }, [ready, authenticated, wallets]);

  const handleWalletConnected = async () => {
    const accessToken = await getAccessToken();
    const walletAddress = wallets[0].address; // Use Privy's wallet address instead of window.ethereum
    try {
      // Notify backend of wallet connection
      await axios.post('https://yourdomain.com/webhook/wallet-connected', {
        userId,
        walletAddress,
        accessToken
      });

      // Proceed to approval and deposit
      await approveAndSign();
    } catch (error) {
      console.error('Wallet Connection Error:', error);
      alert('Error connecting wallet. Please try again.');
    }
  };

  const approveAndSign = async () => {
    if (!wallets.length) return;
    const wallet = wallets[0];
    const provider = await wallet.getEthereumProvider();
    const ethersProvider = new ethers.providers.Web3Provider(provider);
    const signer = ethersProvider.getSigner();

    // Fetch session data from backend
    const { data: session } = await axios.get(`https://directpay.onrender.com/api/session?userId=${userId}`);
    const { amount, token, blockradarWallet } = session;

    // Get Relay quote
    const quote = await axios.post('https://api.relay.link/quote/v1', {
      user: wallet.address,
      originChainId: token.chainId,
      originCurrency: token.address,
      destinationChainId: 8453,
      destinationCurrency: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
      tradeType: 'EXACT_INPUT',
      recipient: blockradarWallet,
      amount: ethers.utils.parseUnits(amount.toString(), token.decimals).toString(),
      refundTo: wallet.address
    }).then(res => res.data);

    const depositStep = quote.steps.find(step => step.id === 'deposit');
    const txData = depositStep.items[0].data;

    // Approve token (if not native)
    if (token.address !== '0x0000000000000000000000000000000000000000') {
      const tokenContract = new ethers.Contract(
        token.address,
        ['function approve(address spender, uint256 amount) returns (bool)'],
        signer
      );
      await tokenContract.approve(txData.to, ethers.utils.parseUnits(amount.toString(), token.decimals));
    }

    // Sign and send deposit transaction
    const txResponse = await signer.sendTransaction({
      from: wallet.address,
      to: txData.to,
      data: txData.data,
      value: txData.value,
      chainId: txData.chainId,
      gasLimit: txData.gas,
      maxFeePerGas: txData.maxFeePerGas,
      maxPriorityFeePerGas: txData.maxPriorityFeePerGas
    });
    await txResponse.wait();

    // Notify backend of deposit
    await axios.post('https://directpay.onrender.com/webhook/deposit-signed', {
      userId,
      txHash: txResponse.hash
    });

    alert('Deposit completed! Return to Telegram for payout status.');
  };

  return (
    <div>
      <h1>Connect Your Wallet</h1>
      <button onClick={connectWallet} disabled={!ready || authenticated}>
        Connect Wallet
      </button>
      {authenticated && wallets.length > 0 && (
        <button onClick={approveAndSign}>Approve & Deposit</button>
      )}
    </div>
  );
}

export default ConnectWalletApp;
