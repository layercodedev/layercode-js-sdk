# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Architecture Overview

- The SDK is a wrapper around the Layercode API to make it easier for developers to use the Layercode API in their web applications.

### Technology Stack

- TypeScript
- Bun (for development)
- Rollup
- Prettier
- ESLint
- Jest

## Important Development Guidelines

- this is a public repository, so all changes should be made in a way that is consistent with the public nature of the repository
- to test changes, you can use the `bun run build` command to build the project and then use the `bun run copy-to-core` command to copy the built files to the core repository so they can be tested in the playground

## Collaboration Guidelines

**Work as a team** - We should collaborate effectively:

- If you notice repetitive or mechanical changes that the user could do more efficiently, ask them to help
- When functionality needs testing, ask the user to test it rather than trying to verify everything programmatically
- For large-scale find/replace operations or pattern-based changes, suggest the user use their IDE or command-line tools
- If you're unsure about the best approach, discuss options with the user before proceeding
- Focus on complex logic and architectural decisions where AI assistance is most valuable

Examples of when to ask for user help:

- Running tests or checking if the code compiles/works
- Making the same change across many files (like removing null checks)
- Verifying UI changes or user-facing functionality
- Applying formatting or linting rules
- Any task that would be faster with direct file system access

## Address Root Causes, Not Symptoms

When encountering the same code issue in multiple locations within the codebase:

1. Pause and analyze - If you find yourself making the same code fix in multiple files or functions, stop and ask: "Why does this pattern exist throughout the code?"
2. Trace to the source - Follow the issue upstream to find where it originates in the code architecture, rather than fixing it at every location.
3. Fix once, benefit everywhere - Make the correction at the architectural source so all dependent code is fixed.
4. Question the design - The widespread issue might reveal a flawed design decision or incorrect type/class definition rather than many individual problems.

Red flags that indicate you're treating symptoms:

- Making the same code change in 5+ locations
- Adding identical defensive code in multiple functions/classes
- Repetitive error handling for the same concern across files
- Copy-pasting the same fix throughout the codebase

Example:
Instead of adding the same null check in 20 methods, ask: "Why is this value nullable in the first place?"

This principle is about recognizing when a code pattern that needs fixing appears in many places, indicating there's likely a single upstream cause that should be addressed instead.

## Backward Compatibility

When implementing new features, refactoring or modifying existing functionality:

- **Always ask before adding backward compatibility code** if it:

  - Adds edge cases or conditional logic
  - Doesn't follow the specification of the new feature
  - Makes the code more complex or harder to understand
  - Creates multiple code paths for the same functionality

- **Prefer clean implementations** that fully embrace the new approach rather than maintaining fallbacks
- **Breaking changes are acceptable** if they lead to cleaner, more maintainable code
- If backward compatibility is truly needed, it should be explicitly requested by the user

Example: When updating a strategy pattern that requires new dependencies, don't add fallbacks for when those dependencies are missing - the strategy should fail if not properly configured.

## Responses

1. **Objective Feedback**: Always provide feedback that is based on verifiable facts and data. Avoid subjective opinions unless explicitly requested.

2. **Certainty in Agreement**: Only confirm that I am correct if you are 100% certain of the accuracy of the information. If you have any doubts, clearly express those doubts instead of agreeing to avoid misleading me.

3. **Clarification Requests**: If a statement is ambiguous or unclear, ask for clarification before providing feedback. This ensures that your response is based on accurate understanding.

4. **Examples for Clarity**: When providing feedback, include examples to illustrate your points. This helps in understanding the context and reasoning behind your feedback.

5. **Edge Cases**: If you encounter a situation where the information is incomplete or contradictory, outline the potential implications and suggest alternative perspectives or solutions. This will help in navigating complex scenarios effectively.
