// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ChatterBlocks
/// @author Amir Shirif
/// @notice Stores encrypted direct-message metadata for a single EVM chain.
/// @dev Message contents are emitted in events while compact headers and indexes remain in storage.
contract ChatterBlocks {
    /// @notice Maximum encrypted payload size accepted by `sendMessage`.
    uint256 public constant MAX_CIPHERTEXT_BYTES = 2048;
    /// @notice Maximum page size returned by inbox and conversation pagination helpers.
    uint256 public constant MAX_PAGE_SIZE = 100;

    /// @notice Reverts when attempting to register an empty chat public key.
    error ZeroChatKey();
    /// @notice Reverts when attempting to send to the zero address.
    error ZeroRecipient();
    /// @notice Reverts when attempting to send an empty ciphertext.
    error EmptyCiphertext();
    /// @notice Reverts when a ciphertext exceeds the configured size cap.
    /// @param provided The ciphertext length supplied by the caller.
    /// @param maximum The maximum ciphertext length accepted by the contract.
    error CiphertextTooLarge(uint256 provided, uint256 maximum);
    /// @notice Reverts when an account without an active chat key participates in a send.
    /// @param account The account missing a registered active chat key.
    error MissingChatKey(address account);
    /// @notice Reverts when a pagination cursor does not exist in the requested index.
    /// @param cursor The cursor value supplied by the caller.
    error InvalidCursor(uint256 cursor);
    /// @notice Reverts when a pagination request uses an invalid page limit.
    /// @param limit The requested page size.
    error InvalidPageLimit(uint256 limit);

    /// @notice Tracks the active public chat key for an account.
    struct ChatKeyState {
        /// @notice Monotonic version number for the active chat key.
        uint64 version;
        /// @notice X25519 public key registered for encrypted messaging.
        bytes32 pubKey;
    }

    /// @notice Compact metadata stored for each message.
    struct MessageHeader {
        /// @notice Canonical conversation identifier derived from the two participant addresses.
        bytes32 conversationId;
        /// @notice Wallet address that submitted the message transaction.
        address sender;
        /// @notice Wallet address that receives the encrypted payload.
        address recipient;
        /// @notice Block timestamp when the message was recorded.
        uint64 sentAt;
        /// @notice Block number containing the `MessageSent` event for this message.
        uint64 blockNumber;
        /// @notice Active sender key version used when the message was encrypted.
        uint64 senderKeyVersion;
        /// @notice Active recipient key version targeted by the sender.
        uint64 recipientKeyVersion;
        /// @notice NaCl box nonce used during encryption.
        bytes24 nonce;
        /// @notice Keccak256 hash of the emitted ciphertext bytes.
        bytes32 ciphertextHash;
    }

    /// @notice Returns the currently active chat key for an account.
    mapping(address => ChatKeyState) public activeChatKeys;
    /// @notice Returns the historical chat public key for an account and version.
    mapping(address => mapping(uint64 => bytes32)) public chatKeyHistory;
    /// @notice Returns the stored header for a message ID.
    mapping(uint256 => MessageHeader) public messageHeaders;

    /// @dev Recipient inboxes store message IDs in append order for cheap reverse pagination.
    mapping(address => uint256[]) private _recipientInboxes;
    /// @dev Conversation indexes store message IDs in append order for cheap reverse pagination.
    mapping(bytes32 => uint256[]) private _conversationMessageIds;
    /// @dev Positions are stored as one-based indexes so zero can represent "missing cursor".
    mapping(address => mapping(uint256 => uint256)) private _recipientInboxPositions;
    /// @dev Positions are stored as one-based indexes so zero can represent "missing cursor".
    mapping(bytes32 => mapping(uint256 => uint256)) private _conversationPositions;

    /// @notice Total number of messages recorded by the contract.
    uint256 public messageCount;

    /// @notice Emitted whenever an account registers or rotates its chat key.
    /// @param account The account whose active chat key changed.
    /// @param version The new active chat key version.
    /// @param pubKey The newly registered X25519 public key.
    event ChatKeyRegistered(address indexed account, uint64 version, bytes32 pubKey);
    /// @notice Emitted whenever a new encrypted message is sent.
    /// @param conversationId Canonical identifier for the sender/recipient pair.
    /// @param sender Wallet address that submitted the message.
    /// @param recipient Wallet address that receives the encrypted payload.
    /// @param messageId Monotonic message identifier assigned by the contract.
    /// @param senderKeyVersion Active sender chat key version used for encryption.
    /// @param recipientKeyVersion Active recipient chat key version targeted by the sender.
    /// @param nonce NaCl box nonce used for encryption.
    /// @param ciphertext Full encrypted payload, emitted in logs instead of stored in state.
    event MessageSent(
        bytes32 indexed conversationId,
        address indexed sender,
        address indexed recipient,
        uint256 messageId,
        uint64 senderKeyVersion,
        uint64 recipientKeyVersion,
        bytes24 nonce,
        bytes ciphertext
    );

    /// @notice Registers or rotates the caller's active chat public key.
    /// @dev Versions increment monotonically and historical keys remain queryable via `chatKeyHistory`.
    /// @param pubKey The caller's X25519 public key.
    /// @return version The new active key version assigned to the caller.
    function registerChatKey(bytes32 pubKey) external returns (uint64 version) {
        if (pubKey == bytes32(0)) revert ZeroChatKey();

        version = activeChatKeys[msg.sender].version + 1;
        activeChatKeys[msg.sender] = ChatKeyState({version: version, pubKey: pubKey});
        chatKeyHistory[msg.sender][version] = pubKey;

        emit ChatKeyRegistered(msg.sender, version, pubKey);
    }

    /// @notice Records an encrypted direct message to a recipient.
    /// @dev Stores only compact metadata on-chain and emits the full ciphertext in the `MessageSent` event.
    /// @param recipient The wallet address receiving the encrypted message.
    /// @param nonce The NaCl box nonce used for encryption.
    /// @param ciphertext The encrypted payload bytes.
    /// @return messageId The newly assigned message identifier.
    function sendMessage(address recipient, bytes24 nonce, bytes calldata ciphertext) external returns (uint256 messageId) {
        if (recipient == address(0)) revert ZeroRecipient();
        if (ciphertext.length == 0) revert EmptyCiphertext();
        if (ciphertext.length > MAX_CIPHERTEXT_BYTES) {
            revert CiphertextTooLarge(ciphertext.length, MAX_CIPHERTEXT_BYTES);
        }

        ChatKeyState memory senderKey = activeChatKeys[msg.sender];
        if (senderKey.version == 0) revert MissingChatKey(msg.sender);

        ChatKeyState memory recipientKey = activeChatKeys[recipient];
        if (recipientKey.version == 0) revert MissingChatKey(recipient);

        bytes32 conversationId = conversationIdOf(msg.sender, recipient);
        messageId = ++messageCount;

        messageHeaders[messageId] = MessageHeader({
            conversationId: conversationId,
            sender: msg.sender,
            recipient: recipient,
            sentAt: uint64(block.timestamp),
            blockNumber: uint64(block.number),
            senderKeyVersion: senderKey.version,
            recipientKeyVersion: recipientKey.version,
            nonce: nonce,
            ciphertextHash: keccak256(ciphertext)
        });

        // Store recipient inbox position so pagination cursors can be validated without scanning arrays.
        _recipientInboxes[recipient].push(messageId);
        _recipientInboxPositions[recipient][messageId] = _recipientInboxes[recipient].length;

        // Store conversation position so reverse pagination can resume from any known message ID.
        _conversationMessageIds[conversationId].push(messageId);
        _conversationPositions[conversationId][messageId] = _conversationMessageIds[conversationId].length;

        emit MessageSent(
            conversationId,
            msg.sender,
            recipient,
            messageId,
            senderKey.version,
            recipientKey.version,
            nonce,
            ciphertext
        );
    }

    /// @notice Computes the canonical conversation identifier for two participants.
    /// @dev The lower address is ordered first so the ID is stable regardless of send direction.
    /// @param accountA The first participant.
    /// @param accountB The second participant.
    /// @return The conversation identifier shared by the two accounts.
    function conversationIdOf(address accountA, address accountB) public pure returns (bytes32) {
        address first = accountA;
        address second = accountB;

        if (second < first) {
            (first, second) = (second, first);
        }

        return keccak256(abi.encodePacked(first, second));
    }

    /// @notice Returns a page of message IDs for a recipient inbox in reverse chronological order.
    /// @dev If `cursor` is zero, pagination starts from the newest inbox entry. Otherwise it starts strictly before `cursor`.
    /// @param account The inbox owner.
    /// @param cursor The message ID before which to continue pagination, or zero to start from the newest entry.
    /// @param limit Maximum number of message IDs to return.
    /// @return messageIds The page of message IDs ordered newest to oldest.
    function getInboxPage(address account, uint256 cursor, uint256 limit) external view returns (uint256[] memory messageIds) {
        if (limit == 0 || limit > MAX_PAGE_SIZE) revert InvalidPageLimit(limit);

        uint256[] storage inbox = _recipientInboxes[account];
        uint256 available = inbox.length;

        if (cursor != 0) {
            uint256 position = _recipientInboxPositions[account][cursor];
            if (position == 0) revert InvalidCursor(cursor);

            available = position - 1;
        }

        uint256 count = available < limit ? available : limit;
        messageIds = new uint256[](count);

        // Pages are returned newest-first so CLI consumers can render recent activity without extra sorting.
        for (uint256 i = 0; i < count; ++i) {
            messageIds[i] = inbox[available - 1 - i];
        }
    }

    /// @notice Returns a page of message IDs for a conversation in reverse chronological order.
    /// @dev If `cursor` is zero, pagination starts from the newest conversation entry. Otherwise it starts strictly before `cursor`.
    /// @param conversationId The canonical conversation identifier.
    /// @param cursor The message ID before which to continue pagination, or zero to start from the newest entry.
    /// @param limit Maximum number of message IDs to return.
    /// @return messageIds The page of message IDs ordered newest to oldest.
    function getConversationPage(bytes32 conversationId, uint256 cursor, uint256 limit)
        external
        view
        returns (uint256[] memory messageIds)
    {
        if (limit == 0 || limit > MAX_PAGE_SIZE) revert InvalidPageLimit(limit);

        uint256[] storage messages = _conversationMessageIds[conversationId];
        uint256 available = messages.length;

        if (cursor != 0) {
            uint256 position = _conversationPositions[conversationId][cursor];
            if (position == 0) revert InvalidCursor(cursor);

            available = position - 1;
        }

        uint256 count = available < limit ? available : limit;
        messageIds = new uint256[](count);

        // Pages are returned newest-first so clients can page backward using the last message ID they saw.
        for (uint256 i = 0; i < count; ++i) {
            messageIds[i] = messages[available - 1 - i];
        }
    }
}
