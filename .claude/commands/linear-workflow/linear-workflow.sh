#!/bin/bash

# Linear Workflow Command for Tot Squad
# This command provides various Linear workflow operations using linctl

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored messages
print_info() { echo -e "${BLUE}ℹ️  $1${NC}"; }
print_success() { echo -e "${GREEN}✅ $1${NC}"; }
print_warning() { echo -e "${YELLOW}⚠️  $1${NC}"; }
print_error() { echo -e "${RED}❌ $1${NC}"; }

# Function to check if linctl is authenticated
check_auth() {
    if ! linctl auth status &>/dev/null; then
        print_error "Not authenticated with Linear"
        print_info "Run: linctl auth"
        exit 1
    fi
}

# Function to show usage
show_help() {
    cat << EOF
Linear Workflow Command for Tot Squad

Usage: $0 <command> [options]

Commands:
    my-issues           Show all issues assigned to you
    today              Show issues updated today
    sprint             Show current sprint issues
    get                Get detailed issue information with comments
    create-bug         Create a new bug issue
    create-feature     Create a new feature issue
    update-status      Update issue status
    quick-comment      Add a quick comment to an issue
    team-status        Show team status overview
    standup            Generate standup report

Examples:
    $0 my-issues
    $0 get TOT-123
    $0 create-bug "Login button not working"
    $0 update-status TOT-123 "In Progress"
    $0 quick-comment TOT-123 "Started working on this"
    $0 standup

EOF
}

# My Issues Command
my_issues() {
    check_auth
    print_info "Fetching your issues..."
    
    echo -e "\n${BLUE}=== 🚨 Urgent Issues ===${NC}"
    linctl issue list --assignee me --priority 1 --include-completed
    
    echo -e "\n${BLUE}=== 🔧 In Progress ===${NC}"
    linctl issue list --assignee me --state "In Progress"
    
    echo -e "\n${BLUE}=== 📋 Todo ===${NC}"
    linctl issue list --assignee me --state "Todo" --limit 10
    
    print_success "Issues loaded successfully"
}

# Today's Activity
today_issues() {
    check_auth
    print_info "Fetching today's activity..."
    
    echo -e "\n${BLUE}=== 📅 Issues Updated Today ===${NC}"
    linctl issue list --newer-than 1_day_ago --sort updated
    
    print_success "Today's issues loaded"
}

# Sprint Issues
sprint_issues() {
    check_auth
    print_info "Fetching current sprint issues..."
    
    # Get issues from the last 2 weeks (typical sprint duration)
    echo -e "\n${BLUE}=== 🏃 Current Sprint (Last 2 Weeks) ===${NC}"
    linctl issue list --newer-than 2_weeks_ago --sort updated --include-completed
    
    print_success "Sprint issues loaded"
}

# Get Issue Details with Enhanced Formatting
get_issue() {
    check_auth
    local issue_id="$1"
    
    if [ -z "$issue_id" ]; then
        print_error "Issue ID is required"
        echo "Usage: $0 get <issue-id>"
        echo "Example: $0 get TOT-123"
        exit 1
    fi
    
    print_info "Fetching issue $issue_id..."
    
    # Get the issue details (suppress panic errors from linctl bug)
    echo -e "\n${BLUE}=== 📋 Issue Details ===${NC}"
    linctl issue get "$issue_id" 2>&1 | grep -v "panic:" | grep -v "goroutine" | grep -v "runtime error" | grep -v "\[signal SIGSEGV" | grep -v "github.com/" | grep -v "go/pkg/mod/" | grep -v "main.main()"
    
    # Get recent comments if any exist
    echo -e "\n${BLUE}=== 💬 Recent Comments ===${NC}"
    if linctl comment list "$issue_id" --limit 5 2>/dev/null | grep -q "NAME"; then
        linctl comment list "$issue_id" --limit 5
    else
        echo "No comments yet"
    fi
    
    # Quick actions reminder
    echo -e "\n${YELLOW}=== ⚡ Quick Actions ===${NC}"
    echo "  • Update status:  lw update-status $issue_id \"In Progress\""
    echo "  • Add comment:    lw quick-comment $issue_id \"Your comment\""
    echo "  • Assign to you:  linctl issue assign $issue_id"
    
    print_success "Issue details loaded"
}

# Create Bug Issue
create_bug() {
    check_auth
    local title="$1"
    
    if [ -z "$title" ]; then
        print_error "Bug title is required"
        echo "Usage: $0 create-bug \"Bug title\""
        exit 1
    fi
    
    print_info "Creating bug issue: $title"
    
    # Default to TOT team for bugs, high priority
    linctl issue create \
        --title "🐛 BUG: $title" \
        --team TOT \
        --priority 2 \
        --assign-me \
        --description "## Bug Description\n\n## Steps to Reproduce\n1. \n\n## Expected Behavior\n\n## Actual Behavior\n\n## Environment\n- Browser/Device: \n- User Type: "
    
    print_success "Bug issue created and assigned to you"
}

# Create Feature Issue
create_feature() {
    check_auth
    local title="$1"
    
    if [ -z "$title" ]; then
        print_error "Feature title is required"
        echo "Usage: $0 create-feature \"Feature title\""
        exit 1
    fi
    
    print_info "Creating feature issue: $title"
    
    # Default to TOT team for features, normal priority
    linctl issue create \
        --title "✨ FEAT: $title" \
        --team TOT \
        --priority 3 \
        --assign-me \
        --description "## Feature Description\n\n## User Story\nAs a [user type]\nI want to [action]\nSo that [benefit]\n\n## Acceptance Criteria\n- [ ] \n\n## Technical Notes\n"
    
    print_success "Feature issue created and assigned to you"
}

# Update Issue Status
update_status() {
    check_auth
    local issue_id="$1"
    local new_status="$2"
    
    if [ -z "$issue_id" ] || [ -z "$new_status" ]; then
        print_error "Issue ID and status are required"
        echo "Usage: $0 update-status <issue-id> <status>"
        echo "Common statuses: Todo, In Progress, In Review, Done"
        exit 1
    fi
    
    print_info "Updating $issue_id to status: $new_status"
    
    linctl issue update "$issue_id" --state "$new_status"
    
    print_success "Issue status updated"
}

# Quick Comment
quick_comment() {
    check_auth
    local issue_id="$1"
    local comment="$2"
    
    if [ -z "$issue_id" ] || [ -z "$comment" ]; then
        print_error "Issue ID and comment are required"
        echo "Usage: $0 quick-comment <issue-id> \"Your comment\""
        exit 1
    fi
    
    print_info "Adding comment to $issue_id"
    
    linctl comment create "$issue_id" --body "$comment"
    
    print_success "Comment added"
}

# Team Status Overview
team_status() {
    check_auth
    print_info "Generating team status overview..."
    
    echo -e "\n${BLUE}=== 👥 Team Overview ===${NC}"
    linctl team list
    
    echo -e "\n${BLUE}=== 🏢 Tot Squad Team Status ===${NC}"
    linctl team get TOT
    
    echo -e "\n${BLUE}=== 👨‍💻 Team Members ===${NC}"
    linctl team members TOT
    
    print_success "Team status loaded"
}

# Standup Report
standup_report() {
    check_auth
    print_info "Generating standup report..."
    
    echo -e "\n${GREEN}=== 📊 Daily Standup Report ===${NC}"
    echo -e "Date: $(date '+%Y-%m-%d %H:%M')\n"
    
    # Yesterday's completed work
    echo -e "${BLUE}📅 Yesterday (Completed):${NC}"
    linctl issue list --assignee me --state "Done" --newer-than 2_days_ago --json 2>/dev/null | \
        jq -r '.[] | "  • \(.identifier): \(.title)"' 2>/dev/null || echo "  • No completed issues"
    
    # Today's work
    echo -e "\n${BLUE}🚀 Today (In Progress):${NC}"
    linctl issue list --assignee me --state "In Progress" --json 2>/dev/null | \
        jq -r '.[] | "  • \(.identifier): \(.title)"' 2>/dev/null || echo "  • No issues in progress"
    
    # Blocked items
    echo -e "\n${BLUE}🚧 Blocked:${NC}"
    linctl issue list --assignee me --state "Blocked" --json 2>/dev/null | \
        jq -r '.[] | "  • \(.identifier): \(.title)"' 2>/dev/null || echo "  • No blocked issues"
    
    # High priority items
    echo -e "\n${BLUE}🔥 High Priority Todo:${NC}"
    linctl issue list --assignee me --state "Todo" --priority 2 --limit 5 --json 2>/dev/null | \
        jq -r '.[] | "  • \(.identifier): \(.title)"' 2>/dev/null || echo "  • No high priority todos"
    
    print_success "Standup report generated"
}

# Main command router
case "$1" in
    my-issues)
        my_issues
        ;;
    today)
        today_issues
        ;;
    sprint)
        sprint_issues
        ;;
    get)
        get_issue "$2"
        ;;
    create-bug)
        create_bug "$2"
        ;;
    create-feature)
        create_feature "$2"
        ;;
    update-status)
        update_status "$2" "$3"
        ;;
    quick-comment)
        quick_comment "$2" "$3"
        ;;
    team-status)
        team_status
        ;;
    standup)
        standup_report
        ;;
    help|--help|-h|"")
        show_help
        ;;
    *)
        print_error "Unknown command: $1"
        show_help
        exit 1
        ;;
esac