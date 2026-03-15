// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ChatterBlocks} from "../src/ChatterBlocks.sol";

interface Vm {
    function warp(uint256 newTimestamp) external;
}

contract Caller {
    function registerChatKey(ChatterBlocks chat, bytes32 pubKey) external returns (uint64) {
        return chat.registerChatKey(pubKey);
    }

    function postInvite(ChatterBlocks chat, bytes32 inviteCommitment, uint64 ttlSeconds) external returns (uint256) {
        return chat.postInvite(inviteCommitment, ttlSeconds);
    }

    function submitInviteResponse(ChatterBlocks chat, uint256 inviteId, bytes calldata ciphertext)
        external
        returns (uint256)
    {
        return chat.submitInviteResponse(inviteId, ciphertext);
    }

    function acceptInviteResponse(ChatterBlocks chat, uint256 inviteId, uint256 responseId) external {
        chat.acceptInviteResponse(inviteId, responseId);
    }

    function cancelInvite(ChatterBlocks chat, uint256 inviteId) external {
        chat.cancelInvite(inviteId);
    }

    function sendMessage(ChatterBlocks chat, address recipient, bytes24 nonce, bytes calldata ciphertext)
        external
        returns (uint256)
    {
        return chat.sendMessage(recipient, nonce, ciphertext);
    }

    function tryPostInvite(ChatterBlocks chat, bytes32 inviteCommitment, uint64 ttlSeconds)
        external
        returns (bool success, bytes memory data)
    {
        (success, data) = address(chat).call(abi.encodeCall(ChatterBlocks.postInvite, (inviteCommitment, ttlSeconds)));
    }

    function trySubmitInviteResponse(ChatterBlocks chat, uint256 inviteId, bytes calldata ciphertext)
        external
        returns (bool success, bytes memory data)
    {
        (success, data) =
            address(chat).call(abi.encodeCall(ChatterBlocks.submitInviteResponse, (inviteId, ciphertext)));
    }

    function tryAcceptInviteResponse(ChatterBlocks chat, uint256 inviteId, uint256 responseId)
        external
        returns (bool success, bytes memory data)
    {
        (success, data) =
            address(chat).call(abi.encodeCall(ChatterBlocks.acceptInviteResponse, (inviteId, responseId)));
    }

    function tryCancelInvite(ChatterBlocks chat, uint256 inviteId) external returns (bool success, bytes memory data) {
        (success, data) = address(chat).call(abi.encodeCall(ChatterBlocks.cancelInvite, (inviteId)));
    }

    function trySendMessage(ChatterBlocks chat, address recipient, bytes24 nonce, bytes calldata ciphertext)
        external
        returns (bool success, bytes memory data)
    {
        (success, data) = address(chat).call(abi.encodeCall(ChatterBlocks.sendMessage, (recipient, nonce, ciphertext)));
    }
}

contract ChatterBlocksTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    ChatterBlocks private chat;
    Caller private alice;
    Caller private bob;
    Caller private carol;

    function setUp() public {
        chat = new ChatterBlocks();
        alice = new Caller();
        bob = new Caller();
        carol = new Caller();
    }

    function testRegisterChatKeyStoresHistoryAndRotates() public {
        bytes32 firstKey = bytes32(uint256(0xA11CE));
        bytes32 secondKey = bytes32(uint256(0xB0B));

        uint64 firstVersion = alice.registerChatKey(chat, firstKey);
        assertEqUint64(firstVersion, uint64(1));

        (uint64 activeVersionAfterFirst, bytes32 activePubKeyAfterFirst) = chat.activeChatKeys(address(alice));
        assertEqUint64(activeVersionAfterFirst, uint64(1));
        assertEqBytes32(activePubKeyAfterFirst, firstKey);
        assertEqBytes32(chat.chatKeyHistory(address(alice), uint64(1)), firstKey);

        uint64 secondVersion = alice.registerChatKey(chat, secondKey);
        assertEqUint64(secondVersion, uint64(2));

        (uint64 activeVersionAfterSecond, bytes32 activePubKeyAfterSecond) = chat.activeChatKeys(address(alice));
        assertEqUint64(activeVersionAfterSecond, uint64(2));
        assertEqBytes32(activePubKeyAfterSecond, secondKey);
        assertEqBytes32(chat.chatKeyHistory(address(alice), uint64(1)), firstKey);
        assertEqBytes32(chat.chatKeyHistory(address(alice), uint64(2)), secondKey);
    }

    function testPostInviteRequiresActiveKeyAndStoresCommitment() public {
        bytes32 inviteCommitment = deriveInviteCommitment(bytes32(uint256(0x1234)), "alpha", "beta");

        (bool missingKeySuccess, bytes memory missingKeyRevertData) = alice.tryPostInvite(chat, inviteCommitment, 1 hours);
        assertTrue(!missingKeySuccess);
        assertCustomErrorSelector(missingKeyRevertData, ChatterBlocks.MissingChatKey.selector);
        assertEqAddress(decodeAddress(missingKeyRevertData), address(alice));

        alice.registerChatKey(chat, bytes32(uint256(0xA11CE)));
        (bool zeroCommitmentSuccess, bytes memory zeroCommitmentRevertData) = alice.tryPostInvite(chat, bytes32(0), 1 hours);
        assertTrue(!zeroCommitmentSuccess);
        assertCustomErrorSelector(zeroCommitmentRevertData, ChatterBlocks.ZeroInviteCommitment.selector);

        uint256 inviteId = alice.postInvite(chat, inviteCommitment, 1 hours);
        ChatterBlocks.Invite memory invite = chat.getInvite(inviteId);

        assertEqAddress(invite.poster, address(alice));
        assertEqUint64(invite.posterKeyVersion, uint64(1));
        assertEqBytes32(invite.inviteCommitment, inviteCommitment);
        assertEqInviteStatus(invite.status, ChatterBlocks.InviteStatus.ACTIVE);
    }

    function testPostInviteRejectsOutOfRangeTtl() public {
        bytes32 inviteCommitment = deriveInviteCommitment(bytes32(uint256(0x4567)), "alpha", "beta");
        alice.registerChatKey(chat, bytes32(uint256(0xA11CE)));

        (bool shortSuccess, bytes memory shortRevertData) =
            alice.tryPostInvite(chat, inviteCommitment, uint64(1 hours - 1));
        assertTrue(!shortSuccess);
        assertCustomErrorSelector(shortRevertData, ChatterBlocks.InvalidInviteTtl.selector);

        (bool longSuccess, bytes memory longRevertData) =
            alice.tryPostInvite(chat, inviteCommitment, uint64(7 days + 1));
        assertTrue(!longSuccess);
        assertCustomErrorSelector(longRevertData, ChatterBlocks.InvalidInviteTtl.selector);
    }

    function testSubmitInviteResponseRequiresResponderKeyAndStoresHeaders() public {
        bytes memory firstCiphertext = hex"010203";
        bytes memory secondCiphertext = hex"040506";

        alice.registerChatKey(chat, bytes32(uint256(0xA11CE)));
        bob.registerChatKey(chat, bytes32(uint256(0xB0B)));
        carol.registerChatKey(chat, bytes32(uint256(0xCA401)));

        uint256 inviteId = alice.postInvite(chat, deriveInviteCommitment(bytes32(uint256(0xA1)), "north", "south"), 1 hours);

        Caller unregistered = new Caller();
        (bool missingKeySuccess, bytes memory missingKeyRevertData) =
            unregistered.trySubmitInviteResponse(chat, inviteId, firstCiphertext);
        assertTrue(!missingKeySuccess);
        assertCustomErrorSelector(missingKeyRevertData, ChatterBlocks.MissingChatKey.selector);
        assertEqAddress(decodeAddress(missingKeyRevertData), address(unregistered));

        uint256 firstResponseId = bob.submitInviteResponse(chat, inviteId, firstCiphertext);
        uint256 secondResponseId = carol.submitInviteResponse(chat, inviteId, secondCiphertext);

        uint256[] memory responsePage = chat.getInviteResponsePage(inviteId, 0, 10);
        uint256[] memory olderResponsePage = chat.getInviteResponsePage(inviteId, secondResponseId, 10);

        assertEqUint256Array(responsePage, asArray(secondResponseId, firstResponseId));
        assertEqUint256Array(olderResponsePage, asArray(firstResponseId));

        assertStoredInviteResponse(firstResponseId, inviteId, address(bob), firstCiphertext);
        assertStoredInviteResponse(secondResponseId, inviteId, address(carol), secondCiphertext);
    }

    function testSubmitInviteResponseRejectsSelfExpiredCancelledAndMatchedInvites() public {
        alice.registerChatKey(chat, bytes32(uint256(0xA11CE)));
        bob.registerChatKey(chat, bytes32(uint256(0xB0B)));
        carol.registerChatKey(chat, bytes32(uint256(0xCA401)));

        uint256 selfInviteId = alice.postInvite(chat, deriveInviteCommitment(bytes32(uint256(0x11)), "paper", "stone"), 1 hours);
        (bool selfSuccess, bytes memory selfRevertData) = alice.trySubmitInviteResponse(chat, selfInviteId, hex"AA");
        assertTrue(!selfSuccess);
        assertCustomErrorSelector(selfRevertData, ChatterBlocks.SelfInviteResponse.selector);

        uint256 expiredInviteId =
            alice.postInvite(chat, deriveInviteCommitment(bytes32(uint256(0x22)), "dawn", "dusk"), 1 hours);
        vm.warp(block.timestamp + 1 hours);

        (bool expiredSuccess, bytes memory expiredRevertData) = bob.trySubmitInviteResponse(chat, expiredInviteId, hex"BB");
        assertTrue(!expiredSuccess);
        assertCustomErrorSelector(expiredRevertData, ChatterBlocks.InviteExpired.selector);
        assertEqInviteStatus(chat.getInvite(expiredInviteId).status, ChatterBlocks.InviteStatus.EXPIRED);

        uint256 cancelledInviteId =
            alice.postInvite(chat, deriveInviteCommitment(bytes32(uint256(0x33)), "river", "harbor"), 1 hours);
        alice.cancelInvite(chat, cancelledInviteId);

        (bool cancelledSuccess, bytes memory cancelledRevertData) =
            bob.trySubmitInviteResponse(chat, cancelledInviteId, hex"CC");
        assertTrue(!cancelledSuccess);
        assertCustomErrorSelector(cancelledRevertData, ChatterBlocks.InviteNotActive.selector);

        uint256 matchedInviteId =
            alice.postInvite(chat, deriveInviteCommitment(bytes32(uint256(0x44)), "ember", "frost"), 1 hours);
        uint256 acceptedResponseId = bob.submitInviteResponse(chat, matchedInviteId, hex"DD");
        alice.acceptInviteResponse(chat, matchedInviteId, acceptedResponseId);

        (bool matchedSuccess, bytes memory matchedRevertData) = carol.trySubmitInviteResponse(chat, matchedInviteId, hex"EE");
        assertTrue(!matchedSuccess);
        assertCustomErrorSelector(matchedRevertData, ChatterBlocks.InviteNotActive.selector);
    }

    function testOnlyPosterCanCancelInvite() public {
        alice.registerChatKey(chat, bytes32(uint256(0xA11CE)));
        bob.registerChatKey(chat, bytes32(uint256(0xB0B)));

        uint256 inviteId =
            alice.postInvite(chat, deriveInviteCommitment(bytes32(uint256(0x55)), "crown", "anchor"), 1 hours);

        (bool success, bytes memory revertData) = bob.tryCancelInvite(chat, inviteId);
        assertTrue(!success);
        assertCustomErrorSelector(revertData, ChatterBlocks.InviteNotPoster.selector);
        assertEqAddress(decodeSecondAddress(revertData), address(bob));
    }

    function testOnlyPosterCanAcceptInviteResponse() public {
        alice.registerChatKey(chat, bytes32(uint256(0xA11CE)));
        bob.registerChatKey(chat, bytes32(uint256(0xB0B)));

        uint256 inviteId =
            alice.postInvite(chat, deriveInviteCommitment(bytes32(uint256(0x66)), "seashell", "lantern"), 1 hours);
        uint256 responseId = bob.submitInviteResponse(chat, inviteId, hex"ABCD");

        (bool success, bytes memory revertData) = bob.tryAcceptInviteResponse(chat, inviteId, responseId);
        assertTrue(!success);
        assertCustomErrorSelector(revertData, ChatterBlocks.InviteNotPoster.selector);
        assertEqAddress(decodeSecondAddress(revertData), address(bob));
    }

    function testAcceptInviteResponseUsesCurrentKeyVersionsAndPreventsReuse() public {
        alice.registerChatKey(chat, bytes32(uint256(0xA11CE)));
        bob.registerChatKey(chat, bytes32(uint256(0xB0B)));
        carol.registerChatKey(chat, bytes32(uint256(0xCA401)));

        uint256 inviteId =
            alice.postInvite(chat, deriveInviteCommitment(bytes32(uint256(0x77)), "signal", "harbor"), 1 hours);
        uint256 responseId = bob.submitInviteResponse(chat, inviteId, hex"DEADBEEF");

        alice.registerChatKey(chat, bytes32(uint256(0xA11CE + 1)));
        bob.registerChatKey(chat, bytes32(uint256(0xB0B + 1)));

        alice.acceptInviteResponse(chat, inviteId, responseId);

        ChatterBlocks.Invite memory invite = chat.getInvite(inviteId);
        ChatterBlocks.InviteResponseHeader memory responseHeader = chat.getInviteResponse(responseId);
        ChatterBlocks.MatchRecord memory matchRecord = chat.getMatchRecord(inviteId);

        assertEqInviteStatus(invite.status, ChatterBlocks.InviteStatus.MATCHED);
        assertEqInviteResponseStatus(responseHeader.status, ChatterBlocks.InviteResponseStatus.ACCEPTED);
        assertEqAddress(matchRecord.responder, address(bob));
        assertEqUint64(matchRecord.posterKeyVersion, uint64(2));
        assertEqUint64(matchRecord.responderKeyVersion, uint64(2));
        assertEqUint256(matchRecord.acceptedResponseId, responseId);
        assertEqUint64(matchRecord.matchedAt, uint64(block.timestamp));

        (bool repeatAcceptSuccess, bytes memory repeatAcceptRevertData) =
            alice.tryAcceptInviteResponse(chat, inviteId, responseId);
        assertTrue(!repeatAcceptSuccess);
        assertCustomErrorSelector(repeatAcceptRevertData, ChatterBlocks.InviteNotActive.selector);

        (bool reuseSuccess, bytes memory reuseRevertData) = carol.trySubmitInviteResponse(chat, inviteId, hex"F0");
        assertTrue(!reuseSuccess);
        assertCustomErrorSelector(reuseRevertData, ChatterBlocks.InviteNotActive.selector);
    }

    function testInvitePaginationReturnsNewestFirstAcrossAllStatuses() public {
        alice.registerChatKey(chat, bytes32(uint256(0xA11CE)));
        bob.registerChatKey(chat, bytes32(uint256(0xB0B)));

        uint256 firstInviteId =
            alice.postInvite(chat, deriveInviteCommitment(bytes32(uint256(0x101)), "alpha", "beta"), 1 hours);
        uint256 secondInviteId =
            alice.postInvite(chat, deriveInviteCommitment(bytes32(uint256(0x102)), "gamma", "delta"), 1 hours);
        uint256 thirdInviteId =
            alice.postInvite(chat, deriveInviteCommitment(bytes32(uint256(0x103)), "echo", "foxtrot"), 1 hours);

        alice.cancelInvite(chat, secondInviteId);
        bob.submitInviteResponse(chat, thirdInviteId, hex"1122");

        uint256[] memory firstPage = chat.getInvitePage(0, 2);
        uint256[] memory secondPage = chat.getInvitePage(secondInviteId, 2);

        assertEqUint256Array(firstPage, asArray(thirdInviteId, secondInviteId));
        assertEqUint256Array(secondPage, asArray(firstInviteId));
    }

    function testSendMessageRevertsWhenSenderIsMissingKey() public {
        bob.registerChatKey(chat, bytes32(uint256(0xB0B)));

        (bool success, bytes memory revertData) = alice.trySendMessage(chat, address(bob), bytes24(uint192(0x1)), hex"AA");

        assertTrue(!success);
        assertCustomErrorSelector(revertData, ChatterBlocks.MissingChatKey.selector);
        assertEqAddress(decodeAddress(revertData), address(alice));
    }

    function testSendMessageRevertsWhenRecipientIsMissingKey() public {
        alice.registerChatKey(chat, bytes32(uint256(0xA11CE)));

        (bool success, bytes memory revertData) = alice.trySendMessage(chat, address(bob), bytes24(uint192(0x2)), hex"BB");

        assertTrue(!success);
        assertCustomErrorSelector(revertData, ChatterBlocks.MissingChatKey.selector);
        assertEqAddress(decodeAddress(revertData), address(bob));
    }

    function testSendMessageRevertsForEmptyAndOversizedCiphertext() public {
        alice.registerChatKey(chat, bytes32(uint256(0xA11CE)));
        bob.registerChatKey(chat, bytes32(uint256(0xB0B)));

        (bool emptySuccess, bytes memory emptyRevertData) =
            alice.trySendMessage(chat, address(bob), bytes24(uint192(0x3)), new bytes(0));
        assertTrue(!emptySuccess);
        assertCustomErrorSelector(emptyRevertData, ChatterBlocks.EmptyCiphertext.selector);

        bytes memory oversizedCiphertext = new bytes(2049);
        (bool largeSuccess, bytes memory largeRevertData) =
            alice.trySendMessage(chat, address(bob), bytes24(uint192(0x4)), oversizedCiphertext);
        assertTrue(!largeSuccess);
        assertCustomErrorSelector(largeRevertData, ChatterBlocks.CiphertextTooLarge.selector);
    }

    function testConversationIdIsStableAcrossDirections() public {
        alice.registerChatKey(chat, bytes32(uint256(0xA11CE)));
        bob.registerChatKey(chat, bytes32(uint256(0xB0B)));

        uint256 firstMessageId = alice.sendMessage(chat, address(bob), bytes24(uint192(0x11)), hex"0102");
        uint256 secondMessageId = bob.sendMessage(chat, address(alice), bytes24(uint192(0x12)), hex"0304");

        bytes32 expectedConversationId = chat.conversationIdOf(address(alice), address(bob));

        (bytes32 firstConversationId,,,,,,,,) = chat.messageHeaders(firstMessageId);
        (bytes32 secondConversationId,,,,,,,,) = chat.messageHeaders(secondMessageId);

        assertEqBytes32(firstConversationId, expectedConversationId);
        assertEqBytes32(secondConversationId, expectedConversationId);
    }

    function testInboxAndConversationPaginationStoreHeaders() public {
        bytes memory firstCiphertext = hex"010203";
        bytes memory secondCiphertext = hex"040506";
        bytes memory thirdCiphertext = hex"070809";
        bytes24 firstNonce = bytes24(uint192(0x21));
        bytes24 secondNonce = bytes24(uint192(0x22));
        bytes24 thirdNonce = bytes24(uint192(0x23));

        alice.registerChatKey(chat, bytes32(uint256(0xA11CE)));
        bob.registerChatKey(chat, bytes32(uint256(0xB0B)));
        carol.registerChatKey(chat, bytes32(uint256(0xCA401)));

        uint256 firstMessageId = alice.sendMessage(chat, address(bob), firstNonce, firstCiphertext);
        uint256 secondMessageId = bob.sendMessage(chat, address(alice), secondNonce, secondCiphertext);
        uint256 thirdMessageId = alice.sendMessage(chat, address(bob), thirdNonce, thirdCiphertext);

        uint256[] memory bobInbox = chat.getInboxPage(address(bob), 0, 10);
        uint256[] memory bobOlderInbox = chat.getInboxPage(address(bob), thirdMessageId, 10);
        uint256[] memory aliceInbox = chat.getInboxPage(address(alice), 0, 10);

        bytes32 conversationId = chat.conversationIdOf(address(alice), address(bob));
        uint256[] memory conversationPage = chat.getConversationPage(conversationId, 0, 10);
        uint256[] memory olderConversationPage = chat.getConversationPage(conversationId, thirdMessageId, 10);

        assertEqUint256Array(bobInbox, asArray(thirdMessageId, firstMessageId));
        assertEqUint256Array(bobOlderInbox, asArray(firstMessageId));
        assertEqUint256Array(aliceInbox, asArray(secondMessageId));
        assertEqUint256Array(conversationPage, asArray(thirdMessageId, secondMessageId, firstMessageId));
        assertEqUint256Array(olderConversationPage, asArray(secondMessageId, firstMessageId));

        assertStoredHeader(firstMessageId, conversationId, address(alice), address(bob), firstNonce, firstCiphertext);
    }

    function deriveInviteCommitment(bytes32 inviteSecret, string memory phraseA, string memory phraseB)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(inviteSecret, phraseA, phraseB));
    }

    function asArray(uint256 first) internal pure returns (uint256[] memory values) {
        values = new uint256[](1);
        values[0] = first;
    }

    function asArray(uint256 first, uint256 second) internal pure returns (uint256[] memory values) {
        values = new uint256[](2);
        values[0] = first;
        values[1] = second;
    }

    function asArray(uint256 first, uint256 second, uint256 third) internal pure returns (uint256[] memory values) {
        values = new uint256[](3);
        values[0] = first;
        values[1] = second;
        values[2] = third;
    }

    function assertStoredInviteResponse(
        uint256 responseId,
        uint256 expectedInviteId,
        address expectedResponder,
        bytes memory expectedCiphertext
    ) internal view {
        ChatterBlocks.InviteResponseHeader memory responseHeader = chat.getInviteResponse(responseId);

        assertEqUint256(responseHeader.inviteId, expectedInviteId);
        assertEqAddress(responseHeader.responder, expectedResponder);
        assertEqUint64(responseHeader.submittedAt, uint64(block.timestamp));
        assertEqUint64(responseHeader.blockNumber, uint64(block.number));
        assertEqUint64(responseHeader.responderKeyVersion, uint64(1));
        assertEqBytes32(responseHeader.ciphertextHash, keccak256(expectedCiphertext));
        assertEqInviteResponseStatus(responseHeader.status, ChatterBlocks.InviteResponseStatus.ACTIVE);
    }

    function assertStoredHeader(
        uint256 messageId,
        bytes32 expectedConversationId,
        address expectedSender,
        address expectedRecipient,
        bytes24 expectedNonce,
        bytes memory expectedCiphertext
    ) internal view {
        (
            bytes32 storedConversationId,
            address storedSender,
            address storedRecipient,
            uint64 storedSentAt,
            uint64 storedBlockNumber,
            uint64 storedSenderKeyVersion,
            uint64 storedRecipientKeyVersion,
            bytes24 storedNonce,
            bytes32 storedCiphertextHash
        ) = chat.messageHeaders(messageId);

        assertEqBytes32(storedConversationId, expectedConversationId);
        assertEqAddress(storedSender, expectedSender);
        assertEqAddress(storedRecipient, expectedRecipient);
        assertEqUint64(storedSentAt, uint64(block.timestamp));
        assertEqUint64(storedBlockNumber, uint64(block.number));
        assertEqUint64(storedSenderKeyVersion, uint64(1));
        assertEqUint64(storedRecipientKeyVersion, uint64(1));
        assertEqBytes24(storedNonce, expectedNonce);
        assertEqBytes32(storedCiphertextHash, keccak256(expectedCiphertext));
    }

    function assertCustomErrorSelector(bytes memory revertData, bytes4 expectedSelector) internal pure {
        require(revertData.length >= 4, "missing selector");

        bytes4 actualSelector;
        assembly {
            actualSelector := mload(add(revertData, 0x20))
        }

        assertEqBytes4(actualSelector, expectedSelector);
    }

    function decodeAddress(bytes memory revertData) internal pure returns (address decodedAddress) {
        require(revertData.length >= 36, "missing address");

        uint256 word;
        assembly {
            word := mload(add(revertData, 0x24))
        }

        decodedAddress = address(uint160(word));
    }

    function decodeSecondAddress(bytes memory revertData) internal pure returns (address decodedAddress) {
        require(revertData.length >= 68, "missing second address");

        uint256 word;
        assembly {
            word := mload(add(revertData, 0x44))
        }

        decodedAddress = address(uint160(word));
    }

    function assertTrue(bool value) internal pure {
        require(value, "assertTrue failed");
    }

    function assertEqInviteStatus(ChatterBlocks.InviteStatus left, ChatterBlocks.InviteStatus right) internal pure {
        require(uint8(left) == uint8(right), "assertEqInviteStatus failed");
    }

    function assertEqInviteResponseStatus(
        ChatterBlocks.InviteResponseStatus left,
        ChatterBlocks.InviteResponseStatus right
    ) internal pure {
        require(uint8(left) == uint8(right), "assertEqInviteResponseStatus failed");
    }

    function assertEqUint64(uint64 left, uint64 right) internal pure {
        require(left == right, "assertEqUint64 failed");
    }

    function assertEqUint256(uint256 left, uint256 right) internal pure {
        require(left == right, "assertEqUint256 failed");
    }

    function assertEqAddress(address left, address right) internal pure {
        require(left == right, "assertEqAddress failed");
    }

    function assertEqBytes4(bytes4 left, bytes4 right) internal pure {
        require(left == right, "assertEqBytes4 failed");
    }

    function assertEqBytes24(bytes24 left, bytes24 right) internal pure {
        require(left == right, "assertEqBytes24 failed");
    }

    function assertEqBytes32(bytes32 left, bytes32 right) internal pure {
        require(left == right, "assertEqBytes32 failed");
    }

    function assertEqUint256Array(uint256[] memory left, uint256[] memory right) internal pure {
        require(left.length == right.length, "assertEqUint256Array length failed");

        for (uint256 i = 0; i < left.length; ++i) {
            require(left[i] == right[i], "assertEqUint256Array item failed");
        }
    }
}
