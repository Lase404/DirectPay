import React, { useEffect } from 'react';
import { PrivyProvider, usePrivy, useConnectWallet, useWallets } from '@privy-io/react-auth';
import axios from 'axios';
import { ethers } from 'ethers';
import { useSearchParams } from 'react-router-dom';

function ConnectWalletApp() {
  return (
    <PrivyProvider appId={process.env.REACT_APP_PRIVY_APP_ID}>
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
    const walletAddress = wallets[0].address;
    try {
      await axios.post('https://directpay.onrender.com/webhook/wallet-connected', {
        userId,
        walletAddress,
        accessToken
      });
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

    const { data: session } = await axios.get(`https://directpay.onrender.com/api/session?userId=${userId}`);
    const { amount, token, blockradarWallet } = session;

    const quote = await axios.post('https://api.relay.link/quote/v1', {
      user: wallet.address,
      originChainId: token.chainId,
      originCurrency: token.address,
      destinationChainId: 8453,
      destinationCurrency: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      tradeType: 'EXACT_INPUT',
      recipient: blockradarWallet,
      amount: amount,
      refundTo: wallet.address
    }).then(res => res.data);

    const depositStep = quote.steps.find(step => step.id === 'deposit');
    const txData = depositStep.items[0].data;

    if (token.address !== '0x0000000000000000000000000000000000000000') {
      const tokenContract = new ethers.Contract(
        token.address,
        ['function approve(address spender, uint256 amount) returns (bool)'],
        signer
      );
      const approveTx = await tokenContract.approve(txData.to, amount);
      await approveTx.wait();
    }

    const txResponse = await signer.sendTransaction({
      from: wallet.address,
      to: txData.to,
      data: txData.data,
      value: txData.value ? ethers.BigNumber.from(txData.value) : undefined,
      chainId: txData.chainId,
      gasLimit: txData.gas ? ethers.BigNumber.from(txData.gas) : undefined,
      maxFeePerGas: txData.maxFeePerGas ? ethers.BigNumber.from(txData.maxFeePerGas) : undefined,
      maxPriorityFeePerGas: txData.maxPriorityFeePerGas ? ethers.BigNumber.from(txData.maxPriorityFeePerGas) : undefined
    });
    await txResponse.wait();

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
