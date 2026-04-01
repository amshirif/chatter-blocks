// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ChatterBlocks} from "../src/ChatterBlocks.sol";

/// @notice Minimal Foundry cheatcode interface used by the deployment script.
interface Vm {
    /// @notice Reads an unsigned integer environment variable.
    /// @param name The environment variable name.
    /// @return value The parsed unsigned integer value.
    function envUint(string calldata name) external returns (uint256 value);
    /// @notice Reads an unsigned integer environment variable or returns a default.
    /// @param name The environment variable name.
    /// @param defaultValue The fallback value when the variable is absent.
    /// @return value The parsed unsigned integer value or `defaultValue`.
    function envOr(string calldata name, uint256 defaultValue) external returns (uint256 value);
    /// @notice Starts broadcasting subsequent transactions with the provided private key.
    /// @param privateKey The deployer private key.
    function startBroadcast(uint256 privateKey) external;
    /// @notice Stops broadcasting transactions.
    function stopBroadcast() external;
}

/// @title DeployChatterBlocksScript
/// @notice Deploys a new `ChatterBlocks` contract using Foundry script broadcasting.
contract DeployChatterBlocksScript {
    /// @dev Canonical Foundry cheatcode address.
    address private constant VM_ADDRESS = address(uint160(uint256(keccak256("hevm cheat code"))));
    /// @dev Cheatcode handle used to access environment variables and broadcasting controls.
    Vm private constant vm = Vm(VM_ADDRESS);

    /// @notice Deploys a new `ChatterBlocks` instance.
    /// @dev Expects `PRIVATE_KEY` or `CHATTER_PRIVATE_KEY` to be present in the environment.
    /// @return deployedAt The address of the deployed contract.
    function run() external returns (address deployedAt) {
        uint256 deployerKey = vm.envOr("PRIVATE_KEY", uint256(0));
        if (deployerKey == 0) {
            deployerKey = vm.envOr("CHATTER_PRIVATE_KEY", uint256(0));
        }
        require(deployerKey != 0, "Set PRIVATE_KEY or CHATTER_PRIVATE_KEY before deploying.");

        vm.startBroadcast(deployerKey);
        deployedAt = address(new ChatterBlocks());
        vm.stopBroadcast();
    }
}
