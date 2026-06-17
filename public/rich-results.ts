// Google Rich Results feature requirements, mapped from Google's structured-data documentation.
// The rules are now generated/pulled from our automated mechanism to ensure we have the
// absolute latest and complete set of Google's official validation rules.

import rules from './google-rules.json' with { type: "json" };

export const RICH_RESULTS: Record<string, any> = rules;

// Resolve aliases (NewsArticle -> Article rules, keeping its own feature label).
export function ruleFor(typeName: string): any {
  const rule = RICH_RESULTS[typeName];
  if (!rule) return null;
  if (rule.aliasOf) return { ...RICH_RESULTS[rule.aliasOf] };
  return rule;
}
