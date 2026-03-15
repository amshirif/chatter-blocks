// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ChatterBlocks
/// @author Amir Shirif
/// @notice Stores encrypted direct-message metadata and chain-only rendezvous state for a single EVM chain.
/// @dev Message and invite-response ciphertext are emitted in events while compact indexes remain in storage.
contract ChatterBlocks {
    /// @notice Maximum encrypted payload size accepted by `sendMessage` and `submitInviteResponse`.
    uint256 public constant MAX_CIPHERTEXT_BYTES = 2048;
    /// @notice Maximum page size returned by pagination helpers.
    uint256 public constant MAX_PAGE_SIZE = 100;
    /// @notice Minimum invite lifetime accepted by `postInvite`.
    uint64 public constant MIN_INVITE_TTL = 1 hours;
    /// @notice Maximum invite lifetime accepted by `postInvite`.
    uint64 public constant MAX_INVITE_TTL = 7 days;

    /// @notice Reverts when attempting to register an empty chat public key.
    error ZeroChatKey();
    /// @notice Reverts when attempting to post an empty invite commitment.
    error ZeroInviteCommitment();
    /// @notice Reverts when attempting to send to the zero address.
    error ZeroRecipient();
    /// @notice Reverts when attempting to store an empty ciphertext.
    error EmptyCiphertext();
    /// @notice Reverts when a ciphertext exceeds the configured size cap.
    /// @param provided The ciphertext length supplied by the caller.
    /// @param maximum The maximum ciphertext length accepted by the contract.
    error CiphertextTooLarge(uint256 provided, uint256 maximum);
    /// @notice Reverts when an account without an active chat key participates in a flow that requires one.
    /// @param account The account missing a registered active chat key.
    error MissingChatKey(address account);
    /// @notice Reverts when a pagination cursor does not exist in the requested index.
    /// @param cursor The cursor value supplied by the caller.
    error InvalidCursor(uint256 cursor);
    /// @notice Reverts when a pagination request uses an invalid page limit.
    /// @param limit The requested page size.
    error InvalidPageLimit(uint256 limit);
    /// @notice Reverts when an invite TTL falls outside the accepted range.
    /// @param ttlSeconds The requested invite lifetime.
    error InvalidInviteTtl(uint64 ttlSeconds);
    /// @notice Reverts when an invite ID does not exist.
    /// @param inviteId The requested invite identifier.
    error MissingInvite(uint256 inviteId);
    /// @notice Reverts when an invite is not in an active state.
    /// @param inviteId The invite identifier.
    error InviteNotActive(uint256 inviteId);
    /// @notice Reverts when an invite has expired.
    /// @param inviteId The invite identifier.
    error InviteExpired(uint256 inviteId);
    /// @notice Reverts when a caller other than the poster tries to perform a poster-only action.
    /// @param poster The address that owns the invite.
    /// @param caller The address that attempted the action.
    error InviteNotPoster(address poster, address caller);
    /// @notice Reverts when the poster tries to answer their own invite.
    error SelfInviteResponse();
    /// @notice Reverts when an invite-response ID does not exist.
    /// @param responseId The requested response identifier.
    error MissingInviteResponse(uint256 responseId);
    /// @notice Reverts when an invite response is not in an active state.
    /// @param responseId The invite-response identifier.
    error InviteResponseNotActive(uint256 responseId);
    /// @notice Reverts when an invite response does not belong to the provided invite ID.
    /// @param inviteId The invite identifier.
    /// @param responseId The invite-response identifier.
    error InviteResponseInviteMismatch(uint256 inviteId, uint256 responseId);

    /// @notice Tracks the active public chat key for an account.
    struct ChatKeyState {
        /// @notice Monotonic version number for the active chat key.
        uint64 version;
        /// @notice X25519 public key registered for encrypted messaging.
        bytes32 pubKey;
    }

    /// @notice Compact metadata stored for each direct message.
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

    /// @notice Status of a rendezvous invite.
    enum InviteStatus {
        NONE,
        ACTIVE,
        MATCHED,
        CANCELLED,
        EXPIRED
    }

    /// @notice Status of an encrypted invite response.
    enum InviteResponseStatus {
        NONE,
        ACTIVE,
        ACCEPTED
    }

    /// @notice Chain-only invite metadata.
    struct Invite {
        /// @notice Wallet address that posted the invite.
        address poster;
        /// @notice Block timestamp when the invite was created.
        uint64 postedAt;
        /// @notice Block timestamp after which the invite is no longer matchable.
        uint64 expiresAt;
        /// @notice Active poster key version at invite creation time.
        uint64 posterKeyVersion;
        /// @notice Commitment derived locally from the invite secret and normalized phrase pair.
        bytes32 inviteCommitment;
        /// @notice Stored invite status. Expiry is applied lazily in view helpers.
        InviteStatus status;
    }

    /// @notice Compact metadata stored for an encrypted invite response.
    struct InviteResponseHeader {
        /// @notice Invite identifier targeted by the response.
        uint256 inviteId;
        /// @notice Wallet address that submitted the response transaction.
        address responder;
        /// @notice Block timestamp when the response was submitted.
        uint64 submittedAt;
        /// @notice Block number containing the `InviteResponseSubmitted` event for this response.
        uint64 blockNumber;
        /// @notice Active responder key version used to encrypt the response.
        uint64 responderKeyVersion;
        /// @notice Keccak256 hash of the emitted ciphertext bytes.
        bytes32 ciphertextHash;
        /// @notice Stored response status.
        InviteResponseStatus status;
    }

    /// @notice Match metadata for an accepted invite response.
    struct MatchRecord {
        /// @notice Wallet address whose response was accepted.
        address responder;
        /// @notice Block timestamp when the invite was matched.
        uint64 matchedAt;
        /// @notice Active poster key version at acceptance time.
        uint64 posterKeyVersion;
        /// @notice Active responder key version at acceptance time.
        uint64 responderKeyVersion;
        /// @notice Invite-response ID that the poster accepted.
        uint256 acceptedResponseId;
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
    /// @dev Invite metadata is keyed by the monotonic invite identifier.
    mapping(uint256 => Invite) private _invites;
    /// @dev Match metadata is keyed by the invite identifier.
    mapping(uint256 => MatchRecord) private _matchRecords;
    /// @dev Invite-response metadata is keyed by the monotonic response identifier.
    mapping(uint256 => InviteResponseHeader) private _inviteResponses;
    /// @dev Per-invite response indexes store response IDs in append order for reverse pagination.
    mapping(uint256 => uint256[]) private _inviteResponseIds;
    /// @dev Positions are stored as one-based indexes so zero can represent "missing cursor".
    mapping(uint256 => mapping(uint256 => uint256)) private _inviteResponsePositions;

    /// @notice Total number of direct messages recorded by the contract.
    uint256 public messageCount;
    /// @notice Total number of invites recorded by the contract.
    uint256 public inviteCount;
    /// @notice Total number of invite responses recorded by the contract.
    uint256 public inviteResponseCount;

    /// @notice Emitted whenever an account registers or rotates its chat key.
    /// @param account The account whose active chat key changed.
    /// @param version The new active chat key version.
    /// @param pubKey The newly registered X25519 public key.
    event ChatKeyRegistered(address indexed account, uint64 version, bytes32 pubKey);
    /// @notice Emitted whenever a new encrypted direct message is sent.
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
    /// @notice Emitted whenever a new invite is posted.
    /// @param inviteId The monotonic invite identifier.
    /// @param poster The wallet address that posted the invite.
    /// @param expiresAt Block timestamp after which the invite expires.
    /// @param posterKeyVersion Active chat key version captured when the invite was posted.
    event InvitePosted(uint256 indexed inviteId, address indexed poster, uint64 expiresAt, uint64 posterKeyVersion);
    /// @notice Emitted whenever an invite is cancelled by its poster.
    /// @param inviteId The invite identifier.
    /// @param poster The wallet address that cancelled the invite.
    event InviteCancelled(uint256 indexed inviteId, address indexed poster);
    /// @notice Emitted whenever an encrypted invite response is submitted.
    /// @param inviteId The invite identifier.
    /// @param responseId The monotonic invite-response identifier.
    /// @param responder The wallet address that submitted the response.
    /// @param responderKeyVersion Active responder key version used for encryption.
    /// @param ciphertext Full encrypted response payload, emitted in logs instead of stored in state.
    event InviteResponseSubmitted(
        uint256 indexed inviteId,
        uint256 indexed responseId,
        address indexed responder,
        uint64 responderKeyVersion,
        bytes ciphertext
    );
    /// @notice Emitted whenever an invite response is accepted and a match is formed.
    /// @param inviteId The invite identifier.
    /// @param poster The wallet address that posted the invite.
    /// @param responder The wallet address whose response was accepted.
    /// @param posterKeyVersion Active poster chat key version at acceptance time.
    /// @param responderKeyVersion Active responder chat key version at acceptance time.
    event InviteMatched(
        uint256 indexed inviteId,
        address indexed poster,
        address indexed responder,
        uint64 posterKeyVersion,
        uint64 responderKeyVersion
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

    /// @notice Posts a rendezvous invite backed by an off-chain commitment.
    /// @param inviteCommitment Commitment derived locally from the invite secret and normalized phrase pair.
    /// @param ttlSeconds Invite lifetime in seconds.
    /// @return inviteId The newly assigned invite identifier.
    function postInvite(bytes32 inviteCommitment, uint64 ttlSeconds) external returns (uint256 inviteId) {
        if (inviteCommitment == bytes32(0)) revert ZeroInviteCommitment();
        if (ttlSeconds < MIN_INVITE_TTL || ttlSeconds > MAX_INVITE_TTL) revert InvalidInviteTtl(ttlSeconds);

        ChatKeyState memory posterKey = activeChatKeys[msg.sender];
        if (posterKey.version == 0) revert MissingChatKey(msg.sender);

        inviteId = ++inviteCount;
        uint64 postedAt = uint64(block.timestamp);

        _invites[inviteId] = Invite({
            poster: msg.sender,
            postedAt: postedAt,
            expiresAt: postedAt + ttlSeconds,
            posterKeyVersion: posterKey.version,
            inviteCommitment: inviteCommitment,
            status: InviteStatus.ACTIVE
        });

        emit InvitePosted(inviteId, msg.sender, postedAt + ttlSeconds, posterKey.version);
    }

    /// @notice Submits an encrypted response to an active invite.
    /// @param inviteId The invite identifier.
    /// @param ciphertext Packed response payload, including the encryption nonce, emitted in logs.
    /// @return responseId The newly assigned invite-response identifier.
    function submitInviteResponse(uint256 inviteId, bytes calldata ciphertext) external returns (uint256 responseId) {
        if (ciphertext.length == 0) revert EmptyCiphertext();
        if (ciphertext.length > MAX_CIPHERTEXT_BYTES) {
            revert CiphertextTooLarge(ciphertext.length, MAX_CIPHERTEXT_BYTES);
        }

        Invite storage invite = _getInviteStorage(inviteId);
        if (invite.status != InviteStatus.ACTIVE) revert InviteNotActive(inviteId);
        if (invite.expiresAt <= block.timestamp) revert InviteExpired(inviteId);
        if (invite.poster == msg.sender) revert SelfInviteResponse();

        ChatKeyState memory responderKey = activeChatKeys[msg.sender];
        if (responderKey.version == 0) revert MissingChatKey(msg.sender);

        responseId = ++inviteResponseCount;
        _inviteResponses[responseId] = InviteResponseHeader({
            inviteId: inviteId,
            responder: msg.sender,
            submittedAt: uint64(block.timestamp),
            blockNumber: uint64(block.number),
            responderKeyVersion: responderKey.version,
            ciphertextHash: keccak256(ciphertext),
            status: InviteResponseStatus.ACTIVE
        });

        _inviteResponseIds[inviteId].push(responseId);
        _inviteResponsePositions[inviteId][responseId] = _inviteResponseIds[inviteId].length;

        emit InviteResponseSubmitted(inviteId, responseId, msg.sender, responderKey.version, ciphertext);
    }

    /// @notice Accepts an active invite response and finalizes the match.
    /// @param inviteId The invite identifier.
    /// @param responseId The invite-response identifier to accept.
    function acceptInviteResponse(uint256 inviteId, uint256 responseId) external {
        Invite storage invite = _getInviteStorage(inviteId);
        if (invite.poster != msg.sender) revert InviteNotPoster(invite.poster, msg.sender);
        if (invite.status != InviteStatus.ACTIVE) revert InviteNotActive(inviteId);
        if (invite.expiresAt <= block.timestamp) revert InviteExpired(inviteId);

        InviteResponseHeader storage response = _getInviteResponseStorage(responseId);
        if (response.inviteId != inviteId) revert InviteResponseInviteMismatch(inviteId, responseId);
        if (response.status != InviteResponseStatus.ACTIVE) revert InviteResponseNotActive(responseId);

        ChatKeyState memory posterKey = activeChatKeys[msg.sender];
        if (posterKey.version == 0) revert MissingChatKey(msg.sender);

        ChatKeyState memory responderKey = activeChatKeys[response.responder];
        if (responderKey.version == 0) revert MissingChatKey(response.responder);

        invite.status = InviteStatus.MATCHED;
        response.status = InviteResponseStatus.ACCEPTED;
        _matchRecords[inviteId] = MatchRecord({
            responder: response.responder,
            matchedAt: uint64(block.timestamp),
            posterKeyVersion: posterKey.version,
            responderKeyVersion: responderKey.version,
            acceptedResponseId: responseId
        });

        emit InviteMatched(inviteId, msg.sender, response.responder, posterKey.version, responderKey.version);
    }

    /// @notice Cancels an active invite owned by the caller.
    /// @param inviteId The invite identifier.
    function cancelInvite(uint256 inviteId) external {
        Invite storage invite = _getInviteStorage(inviteId);
        if (invite.poster != msg.sender) revert InviteNotPoster(invite.poster, msg.sender);
        if (invite.status != InviteStatus.ACTIVE) revert InviteNotActive(inviteId);
        if (invite.expiresAt <= block.timestamp) revert InviteExpired(inviteId);

        invite.status = InviteStatus.CANCELLED;

        emit InviteCancelled(inviteId, msg.sender);
    }

    /// @notice Records an encrypted direct message to a recipient.
    /// @dev Stores only compact metadata on-chain and emits the full ciphertext in the `MessageSent` event.
    /// @param recipient The wallet address receiving the encrypted payload.
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

    /// @notice Returns the invite metadata for an invite ID, applying lazy expiry.
    /// @param inviteId The invite identifier.
    /// @return invite The invite metadata with `status` normalized to `EXPIRED` when applicable.
    function getInvite(uint256 inviteId) external view returns (Invite memory invite) {
        Invite storage storedInvite = _getInviteStorage(inviteId);
        invite = storedInvite;
        invite.status = _effectiveInviteStatus(storedInvite);
    }

    /// @notice Returns a page of invite IDs in reverse chronological order.
    /// @dev Invites are stored under contiguous monotonic IDs, so reverse pagination does not require a secondary index.
    /// @param cursor The invite ID before which to continue pagination, or zero to start from the newest invite.
    /// @param limit Maximum number of invite IDs to return.
    /// @return inviteIds The page of invite IDs ordered newest to oldest.
    function getInvitePage(uint256 cursor, uint256 limit) external view returns (uint256[] memory inviteIds) {
        if (limit == 0 || limit > MAX_PAGE_SIZE) revert InvalidPageLimit(limit);

        uint256 available = inviteCount;
        if (cursor != 0) {
            if (cursor > inviteCount) revert InvalidCursor(cursor);
            available = cursor - 1;
        }

        uint256 count = available < limit ? available : limit;
        inviteIds = new uint256[](count);
        for (uint256 i = 0; i < count; ++i) {
            inviteIds[i] = available - i;
        }
    }

    /// @notice Returns the compact metadata for an invite response.
    /// @param responseId The invite-response identifier.
    /// @return responseHeader The stored invite-response header.
    function getInviteResponse(uint256 responseId) external view returns (InviteResponseHeader memory responseHeader) {
        InviteResponseHeader storage storedResponse = _getInviteResponseStorage(responseId);
        responseHeader = storedResponse;
    }

    /// @notice Returns a page of response IDs for an invite in reverse chronological order.
    /// @param inviteId The invite identifier.
    /// @param cursor The response ID before which to continue pagination, or zero to start from the newest response.
    /// @param limit Maximum number of response IDs to return.
    /// @return responseIds The page of response IDs ordered newest to oldest.
    function getInviteResponsePage(uint256 inviteId, uint256 cursor, uint256 limit)
        external
        view
        returns (uint256[] memory responseIds)
    {
        _getInviteStorage(inviteId);
        if (limit == 0 || limit > MAX_PAGE_SIZE) revert InvalidPageLimit(limit);

        uint256[] storage responseIndex = _inviteResponseIds[inviteId];
        uint256 available = responseIndex.length;

        if (cursor != 0) {
            uint256 position = _inviteResponsePositions[inviteId][cursor];
            if (position == 0) revert InvalidCursor(cursor);

            available = position - 1;
        }

        uint256 count = available < limit ? available : limit;
        responseIds = new uint256[](count);
        for (uint256 i = 0; i < count; ++i) {
            responseIds[i] = responseIndex[available - 1 - i];
        }
    }

    /// @notice Returns the persisted match metadata for an invite ID.
    /// @param inviteId The invite identifier.
    /// @return matchRecord The stored match metadata.
    function getMatchRecord(uint256 inviteId) external view returns (MatchRecord memory matchRecord) {
        _getInviteStorage(inviteId);
        matchRecord = _matchRecords[inviteId];
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

    /// @dev Returns the effective invite status, lazily mapping active expired invites to `EXPIRED`.
    function _effectiveInviteStatus(Invite storage invite) internal view returns (InviteStatus) {
        if (invite.status == InviteStatus.ACTIVE && invite.expiresAt <= block.timestamp) {
            return InviteStatus.EXPIRED;
        }

        return invite.status;
    }

    /// @dev Reverts if the invite does not exist and otherwise returns a storage pointer.
    function _getInviteStorage(uint256 inviteId) internal view returns (Invite storage invite) {
        if (inviteId == 0 || inviteId > inviteCount) revert MissingInvite(inviteId);
        invite = _invites[inviteId];
    }

    /// @dev Reverts if the invite response does not exist and otherwise returns a storage pointer.
    function _getInviteResponseStorage(uint256 responseId) internal view returns (InviteResponseHeader storage responseHeader) {
        if (responseId == 0 || responseId > inviteResponseCount) revert MissingInviteResponse(responseId);
        responseHeader = _inviteResponses[responseId];
    }
}
