# DirectPay Telegram Bot
This Bot current operates on the testnets of BASE, BNB and Polygon
## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Technologies Used](#technologies-used)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
  - [User Functions](#user-functions)
  - [Admin Functions](#admin-functions)
- [Challenges](#challenges)
- [Contributing](#contributing)
- [License](#license)
- [Contact](#contact)

## Overview

DirectPay is a Telegram bot designed to streamline cryptocurrency transactions by allowing users to generate wallets, link their bank accounts, and receive fiat payouts seamlessly. It leverages various APIs and services to ensure secure and efficient operations, providing both users and administrators with a robust platform for managing crypto-to-fiat conversions.

## Features

### For Users

- **Wallet Generation:** Create multiple crypto wallets directly within Telegram.
- **Bank Account Linking:** Securely link your bank account using real-time verification via Paystack.
- **Transaction Management:** View and track all your crypto transactions in one place.
- **Learn About Base:** Access detailed information about the Base Ethereum Layer 2 network with an interactive pagination system.
- **Support:** Get assistance through various support options integrated into the bot.

### For Administrators

- **Transaction Oversight:** View all user transactions with detailed information.
- **Mark Transactions as Paid:** Update transaction statuses and notify users with detailed messages.
- **Send Messages and Images to Users:** Communicate directly with users by sending custom messages and images.
- **Error Handling:** Receive refined notifications about webhook events and system errors without raw JSON data cluttering your admin panel.

## Technologies Used

Node.js, Telegraf, Firebase Firestore, Express.js, Web3.js, Axios, BlockRadar API, Paystack API, Telegram Bot API, fs, path, JSON

## Installation

1. **Clone the Repository**

   ```bash
   git clone https://github.com/LASE404/directpay.git
   cd directpay-telegram-bot
   ```

2. **Install Dependencies**

   Ensure you have [Node.js](https://nodejs.org/) installed. Then, install the necessary packages:

   ```bash
   npm install
   ```

3. **Setup Firebase**

   - Create a Firebase project in the [Firebase Console](https://console.firebase.google.com/).
   - Navigate to **Project Settings** and generate a new service account key.
   - Download the `serviceAccountKey.json` file and place it in the root directory of the project.

4. **Configure Environment Variables**

   Create a `.env` file in the root directory and add the following variables:

   ```env
   BOT_TOKEN=your_telegram_bot_token
   PAYSTACK_API_KEY=your_paystack_api_key
   BLOCKRADAR_API_KEY=your_blockradar_api_key
   BLOCKRADAR_WALLET_ID=your_blockradar_wallet_id
   PERSONAL_CHAT_ID=your_personal_chat_id
   FIREBASE_DATABASE_URL=your_firebase_database_url
   ```

   Replace the placeholder values with your actual credentials.

## Configuration

- **Bank List:** The `bankList` array in the code includes banks with their names, codes, and aliases. You can expand this list by adding more banks and their respective aliases to accommodate a wider range of user inputs.

  ```javascript
  const bankList = [
    {
      name: 'Access Bank',
      code: '044',
      aliases: ['access', 'access bank', 'accessbank'],
    },
    {
      name: 'GTBank',
      code: '058',
      aliases: ['gtbank', 'guaranty trust bank', 'gtb', 'gt bank'],
    },
    // Add more banks as needed
  ];
  ```

## Usage

### User Functions

1. **Start the Bot**

   Open Telegram and search for your bot using its username. Click **Start** to begin.

2. **Generate Wallet**

   - Click on **💼 Generate Wallet** to create a new crypto wallet.
   - The bot will generate a wallet address and prompt you to link your bank account.

3. **Link Bank Account**

   - Click on **🏦 Link Bank Account**.
   - Enter your bank name (e.g., Access Bank). The bot recognizes various aliases.
   - Enter your 10-digit bank account number.
   - Confirm your bank details before linking.

4. **View Wallet**

   - Click on **💼 View Wallet** to see all your generated wallets and their linked bank status.
   - Option to create a new wallet if your first wallet is linked.

5. **View Transactions**

   - Click on **💰 Transactions** to view all your crypto transactions, their statuses, and details.

6. **Learn About Base**

   - Click on **📘 Learn About Base** to access information about the Base Ethereum Layer 2 network.
   - Navigate through the information using **Next ➡️** and **⬅️ Back** buttons without cluttering the chat.

7. **Support**

   - Click on **ℹ️ Support** to access various support options.
   - Options include **How It Works**, **Transaction Not Received**, and **Contact Support**.

### Admin Functions

1. **Access Admin Panel**

   - Only users with the `PERSONAL_CHAT_ID` can access admin functionalities.
   - Upon starting the bot, admins receive an **Admin Panel** with options.

2. **View All Transactions**

   - Click on **View Transactions** to see all user transactions with detailed information.

3. **Mark Transactions as Paid**

   - Click on **Mark Paid** to view a list of pending transactions.
   - Select the desired transaction to mark it as paid.
   - Users receive a detailed notification upon successful marking.

4. **Send Messages to Users**

   - Click on **Send Message** to communicate directly with users.
   - Enter the user's ID and compose your message.

5. **Upload Images to Users**

   - Click on **Upload Image to User**.
   - Enter the user's ID and upload the desired image.
   - The user will receive the image directly in their chat.

**Conclusion:**

I was able to overcome all these challenges through dedication and a proactive approach to problem-solving. By staying focused and leveraging my skills, I ensured that the bot operates smoothly and provides an excellent user experience. *(And yes, I was able to fix them all because I'm based! 😎)*


## Contact

For any questions or support, please reach out to (https://t.me/MAXCSWAP) on Telegram.

```
