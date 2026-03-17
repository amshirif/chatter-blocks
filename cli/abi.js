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
    name: "postInvite",
    stateMutability: "nonpayable",
    inputs: [
      { name: "inviteCommitment", type: "bytes32" },
      { name: "ttlSeconds", type: "uint64" }
    ],
    outputs: [{ name: "inviteId", type: "uint256" }]
  },
  {
    type: "function",
    name: "submitInviteResponse",
    stateMutability: "nonpayable",
    inputs: [
      { name: "inviteId", type: "uint256" },
      { name: "ciphertext", type: "bytes" }
    ],
    outputs: [{ name: "responseId", type: "uint256" }]
  },
  {
    type: "function",
    name: "acceptInviteResponse",
    stateMutability: "nonpayable",
    inputs: [
      { name: "inviteId", type: "uint256" },
      { name: "responseId", type: "uint256" }
    ],
    outputs: []
  },
  {
    type: "function",
    name: "cancelInvite",
    stateMutability: "nonpayable",
    inputs: [{ name: "inviteId", type: "uint256" }],
    outputs: []
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
    name: "getInvitePage",
    stateMutability: "view",
    inputs: [
      { name: "cursor", type: "uint256" },
      { name: "limit", type: "uint256" }
    ],
    outputs: [{ name: "inviteIds", type: "uint256[]" }]
  },
  {
    type: "function",
    name: "getInviteResponsePage",
    stateMutability: "view",
    inputs: [
      { name: "inviteId", type: "uint256" },
      { name: "cursor", type: "uint256" },
      { name: "limit", type: "uint256" }
    ],
    outputs: [{ name: "responseIds", type: "uint256[]" }]
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
    name: "getInvite",
    stateMutability: "view",
    inputs: [{ name: "inviteId", type: "uint256" }],
    outputs: [
      { name: "poster", type: "address" },
      { name: "postedAt", type: "uint64" },
      { name: "expiresAt", type: "uint64" },
      { name: "posterKeyVersion", type: "uint64" },
      { name: "inviteCommitment", type: "bytes32" },
      { name: "status", type: "uint8" }
    ]
  },
  {
    type: "function",
    name: "getInviteResponse",
    stateMutability: "view",
    inputs: [{ name: "responseId", type: "uint256" }],
    outputs: [
      { name: "inviteId", type: "uint256" },
      { name: "responder", type: "address" },
      { name: "submittedAt", type: "uint64" },
      { name: "blockNumber", type: "uint64" },
      { name: "responderKeyVersion", type: "uint64" },
      { name: "ciphertextHash", type: "bytes32" },
      { name: "status", type: "uint8" }
    ]
  },
  {
    type: "function",
    name: "getMatchRecord",
    stateMutability: "view",
    inputs: [{ name: "inviteId", type: "uint256" }],
    outputs: [
      { name: "responder", type: "address" },
      { name: "matchedAt", type: "uint64" },
      { name: "posterKeyVersion", type: "uint64" },
      { name: "responderKeyVersion", type: "uint64" },
      { name: "acceptedResponseId", type: "uint256" }
    ]
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
  },
  {
    type: "event",
    name: "InvitePosted",
    anonymous: false,
    inputs: [
      { indexed: true, name: "inviteId", type: "uint256" },
      { indexed: true, name: "poster", type: "address" },
      { indexed: false, name: "expiresAt", type: "uint64" },
      { indexed: false, name: "posterKeyVersion", type: "uint64" }
    ]
  },
  {
    type: "event",
    name: "InviteCancelled",
    anonymous: false,
    inputs: [
      { indexed: true, name: "inviteId", type: "uint256" },
      { indexed: true, name: "poster", type: "address" }
    ]
  },
  {
    type: "event",
    name: "InviteResponseSubmitted",
    anonymous: false,
    inputs: [
      { indexed: true, name: "inviteId", type: "uint256" },
      { indexed: true, name: "responseId", type: "uint256" },
      { indexed: true, name: "responder", type: "address" },
      { indexed: false, name: "responderKeyVersion", type: "uint64" },
      { indexed: false, name: "ciphertext", type: "bytes" }
    ]
  },
  {
    type: "event",
    name: "InviteMatched",
    anonymous: false,
    inputs: [
      { indexed: true, name: "inviteId", type: "uint256" },
      { indexed: true, name: "poster", type: "address" },
      { indexed: true, name: "responder", type: "address" },
      { indexed: false, name: "posterKeyVersion", type: "uint64" },
      { indexed: false, name: "responderKeyVersion", type: "uint64" }
    ]
  }
];
