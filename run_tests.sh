#!/bin/bash

# Swift Unit Test Runner for Sunny App
# This script runs the unit tests for the EventKit reminder functionality

echo "🧪 Running Swift Unit Tests for EventKit Reminder Service..."
echo ""

# Check if we're in the right directory
if [ ! -f "sunny_app/VoiceAgent.xcodeproj/project.pbxproj" ]; then
    echo "❌ Error: Please run this script from the project root directory"
    echo "   Expected to find: sunny_app/VoiceAgent.xcodeproj/project.pbxproj"
    exit 1
fi

# Change to the app directory
cd sunny_app

echo "📱 Building and testing VoiceAgent..."
echo ""

# Run the tests
xcodebuild test \
    -scheme VoiceAgent \
    -destination 'platform=iOS Simulator,name=iPhone 15' \
    -quiet

# Check if tests passed
if [ $? -eq 0 ]; then
    echo ""
    echo "✅ All tests passed! 🎉"
    echo ""
    echo "Test Summary:"
    echo "  • EventKitReminderService initialization"
    echo "  • Date parsing (multiple formats)"
    echo "  • Error handling"
    echo "  • JSON serialization/deserialization"
    echo "  • RPC data flow integration"
    echo "  • Mock service functionality"
else
    echo ""
    echo "❌ Some tests failed. Check the output above for details."
    exit 1
fi

echo ""
echo "🚀 Ready to test the reminder feature in the app!"
