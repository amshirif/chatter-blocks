export const chatterBlocksAbi = [
  {
    type: "function",
    name: "registerChatKey",
    stateMutability: "nonpayable",
    inputs: [{ name: "pubKey", type: "bytes32" }],
    outputs: [{ name: "version", type: "uint64" }]
  },
  {
    type: "function",
    name: "sendMessage",
    stateMutability: "nonpayable",
    inputs: [
      { name: "recipient", type: "address" },
      { name: "nonce", type: "bytes24" },
      { name: "ciphertext", type: "bytes" }
    ],
    outputs: [{ name: "messageId", type: "uint256" }]
  },
  {
    type: "function",
    name: "conversationIdOf",
    stateMutability: "pure",
    inputs: [
      { name: "accountA", type: "address" },
      { name: "accountB", type: "address" }
    ],
    outputs: [{ name: "conversationId", type: "bytes32" }]
  },
  {
    type: "function",
    name: "getInboxPage",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "cursor", type: "uint256" },
      { name: "limit", type: "uint256" }
    ],
    outputs: [{ name: "messageIds", type: "uint256[]" }]
  },
  {
    type: "function",
    name: "getConversationPage",
    stateMutability: "view",
    inputs: [
      { name: "conversationId", type: "bytes32" },
      { name: "cursor", type: "uint256" },
      { name: "limit", type: "uint256" }
    ],
    outputs: [{ name: "messageIds", type: "uint256[]" }]
  },
  {
    type: "function",
    name: "activeChatKeys",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [
      { name: "version", type: "uint64" },
      { name: "pubKey", type: "bytes32" }
    ]
  },
  {
    type: "function",
    name: "chatKeyHistory",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "version", type: "uint64" }
    ],
    outputs: [{ name: "pubKey", type: "bytes32" }]
  },
  {
    type: "function",
    name: "messageHeaders",
    stateMutability: "view",
    inputs: [{ name: "messageId", type: "uint256" }],
    outputs: [
      { name: "conversationId", type: "bytes32" },
      { name: "sender", type: "address" },
      { name: "recipient", type: "address" },
      { name: "sentAt", type: "uint64" },
      { name: "blockNumber", type: "uint64" },
      { name: "senderKeyVersion", type: "uint64" },
      { name: "recipientKeyVersion", type: "uint64" },
      { name: "nonce", type: "bytes24" },
      { name: "ciphertextHash", type: "bytes32" }
    ]
  },
  {
    type: "event",
    name: "ChatKeyRegistered",
    anonymous: false,
    inputs: [
      { indexed: true, name: "account", type: "address" },
      { indexed: false, name: "version", type: "uint64" },
      { indexed: false, name: "pubKey", type: "bytes32" }
    ]
  },
  {
    type: "event",
    name: "MessageSent",
    anonymous: false,
    inputs: [
      { indexed: true, name: "conversationId", type: "bytes32" },
      { indexed: true, name: "sender", type: "address" },
      { indexed: true, name: "recipient", type: "address" },
      { indexed: false, name: "messageId", type: "uint256" },
      { indexed: false, name: "senderKeyVersion", type: "uint64" },
      { indexed: false, name: "recipientKeyVersion", type: "uint64" },
      { indexed: false, name: "nonce", type: "bytes24" },
      { indexed: false, name: "ciphertext", type: "bytes" }
    ]
  }
];
