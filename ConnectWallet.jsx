import React, { useEffect } from 'react';
import { PrivyProvider, usePrivy, useWallets } from '@privy-io/react-auth';
import { ethers } from 'ethers';
import './ConnectWalletApp.css';

const App = () => {
  const urlParams = new URLSearchParams(window.location.search);
  const userId = urlParams.get('userId');
  const quoteId = urlParams.get('quoteId');
  const isExecution = !!quoteId;

  return (
    <PrivyProvider appId={process.env.REACT_APP_PRIVY_APP_ID}>
      {isExecution ? <ExecuteComponent userId={userId} quoteId={quoteId} /> : <ConnectWalletComponent userId={userId} />}
    </PrivyProvider>
  );
};

const ConnectWalletComponent = ({ userId }) => {
  const { login, authenticated, ready } = usePrivy();
  const { wallets } = useWallets();

  useEffect(() => {
    if (ready && authenticated && wallets.length > 0) {
      const walletAddress = wallets[0].address;
      fetch('/webhook/wallet-connected', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, walletAddress }),
      }).then(() => window.close());
    }
  }, [ready, authenticated, wallets, userId]);

  if (!ready) return <div>Loading...</div>;

  return (
    <div className="connect-wallet">
      <h1>Connect Your Wallet</h1>
      {!authenticated && <button onClick={login}>Connect Wallet</button>}
      {authenticated && <p>Connecting...</p>}
    </div>
  );
};

const ExecuteComponent = ({ userId, quoteId }) => {
  const { ready, authenticated } = usePrivy();
  const { wallets } = useWallets();

  useEffect(() => {
    if (ready && authenticated && wallets.length > 0) {
      executeTransaction(wallets[0], quoteId, userId);
    }
  }, [ready, authenticated, wallets, quoteId, userId]);

  const executeTransaction = async (wallet, quoteId, userId) => {
    try {
      const provider = await wallet.getEthersProvider();
      const signer = provider.getSigner();
      const quoteResponse = await fetch(`https://api.relay.link/quote/${quoteId}`);
      const quote = await quoteResponse.json();

      const { originCurrency, amount } = quote[0];
      if (originCurrency !== '0x0000000000000000000000000000000000000000') { // ERC-20
        const erc20Abi = ['function approve(address spender, uint256 amount) public returns (bool)'];
        const tokenContract = new ethers.Contract(originCurrency, erc20Abi, signer);
        const tx = await tokenContract.approve(quote[0].spender, amount);
        await tx.wait();
      }

      const txResponse = await signer.sendTransaction({
        to: quote[0].to,
        data: quote[0].data,
        value: originCurrency === '0x0000000000000000000000000000000000000000' ? amount : 0,
      });
      await txResponse.wait();

      alert('Transaction executed successfully!');
      window.close();
    } catch (error) {
      console.error('Execution failed:', error);
      alert('Transaction failed. Please try again.');
    }
  };

  if (!ready) return <div>Loading...</div>;

  return (
    <div className="connect-wallet">
      <h1>Approve & Execute Sell</h1>
      <p>Processing your transaction...</p>
    </div>
  );
};

export default App;
