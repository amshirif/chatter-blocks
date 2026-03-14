// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ChatterBlocks} from "../src/ChatterBlocks.sol";

contract Caller {
    function registerChatKey(ChatterBlocks chat, bytes32 pubKey) external returns (uint64) {
        return chat.registerChatKey(pubKey);
    }

    function sendMessage(ChatterBlocks chat, address recipient, bytes24 nonce, bytes calldata ciphertext)
        external
        returns (uint256)
    {
        return chat.sendMessage(recipient, nonce, ciphertext);
    }

    function trySendMessage(ChatterBlocks chat, address recipient, bytes24 nonce, bytes calldata ciphertext)
        external
        returns (bool success, bytes memory data)
    {
        (success, data) = address(chat).call(abi.encodeCall(ChatterBlocks.sendMessage, (recipient, nonce, ciphertext)));
    }
}

contract ChatterBlocksTest {
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

    function assertTrue(bool value) internal pure {
        require(value, "assertTrue failed");
    }

    function assertEqUint64(uint64 left, uint64 right) internal pure {
        require(left == right, "assertEqUint64 failed");
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
