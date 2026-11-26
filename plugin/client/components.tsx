import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon, TextInput } from "@getpaseo/plugin/client/ui";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
export type Theme = PluginScreenProps["theme"];
export function Button({
  theme,
  label,
  onPress,
  disabled = false,
  primary = false,
  danger = false,
  icon,
}: {
  theme: Theme;
  label: string;
  onPress(): void;
  disabled?: boolean;
  primary?: boolean;
  danger?: boolean;
  icon?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 40,
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: 8,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 7,
        backgroundColor: primary ? theme.colors.accent : theme.colors.surface2,
        borderWidth: 1,
        borderColor: primary ? "transparent" : theme.colors.border,
        opacity: disabled ? 0.4 : pressed ? 0.75 : 1,
      })}
    >
      {icon && (
        <Icon
          name={icon}
          size={16}
          color={
            primary
              ? theme.colors.accentForeground
              : danger
                ? theme.colors.statusDanger
                : theme.colors.foreground
          }
        />
      )}
      <Text
        style={{
          fontSize: 14,
          fontWeight: "600",
          color: primary
            ? theme.colors.accentForeground
            : danger
              ? theme.colors.statusDanger
              : theme.colors.foreground,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
export function Field({
  theme,
  label,
  value,
  onChange,
  placeholder,
  hint,
  disabled = false,
  secret = false,
}: {
  theme: Theme;
  label: string;
  value: string;
  onChange(value: string): void;
  placeholder?: string;
  hint?: string;
  disabled?: boolean;
  secret?: boolean;
}) {
  const [focus, setFocus] = useState(false);
  return (
    <View style={{ gap: 7 }}>
      <Text
        style={{
          fontSize: 14,
          fontWeight: "500",
          color: theme.colors.foreground,
        }}
      >
        {label}
      </Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        editable={!disabled}
        secureTextEntry={secret}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.foregroundMuted}
        autoCapitalize="none"
        autoCorrect={false}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        style={{
          fontSize: 15,
          color: theme.colors.foreground,
          backgroundColor: theme.colors.surface0,
          borderWidth: 1,
          borderColor: focus ? theme.colors.accent : theme.colors.border,
          borderRadius: 8,
          paddingHorizontal: 12,
          paddingVertical: 11,
          minHeight: 44,
          opacity: disabled ? 0.6 : 1,
        }}
      />
      {hint && (
        <Text
          style={{
            fontSize: 14,
            lineHeight: 20,
            color: theme.colors.foregroundMuted,
          }}
        >
          {hint}
        </Text>
      )}
    </View>
  );
}
export function Choice({
  theme,
  label,
  description,
  checked,
  onChange,
  disabled = false,
}: {
  theme: Theme;
  label: string;
  description?: string;
  checked: boolean;
  onChange(value: boolean): void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={() => onChange(!checked)}
      style={({ pressed }) => ({
        flexDirection: "row",
        gap: 11,
        paddingVertical: 10,
        alignItems: "flex-start",
        opacity: disabled ? 0.45 : pressed ? 0.75 : 1,
      })}
    >
      <View
        style={{
          width: 20,
          height: 20,
          borderRadius: 5,
          borderWidth: 1,
          borderColor: checked ? theme.colors.accent : theme.colors.border,
          backgroundColor: checked
            ? theme.colors.accent
            : theme.colors.surface0,
          alignItems: "center",
          justifyContent: "center",
          marginTop: 1,
        }}
      >
        {checked && (
          <Icon name="Check" size={14} color={theme.colors.accentForeground} />
        )}
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <Text
          style={{
            fontSize: 15,
            lineHeight: 21,
            color: theme.colors.foreground,
            fontWeight: "500",
          }}
        >
          {label}
        </Text>
        {description && (
          <Text
            style={{
              fontSize: 14,
              lineHeight: 20,
              color: theme.colors.foregroundMuted,
            }}
          >
            {description}
          </Text>
        )}
      </View>
    </Pressable>
  );
}
export function Disclosure({
  theme,
  title = "Advanced settings",
  label,
  summary,
  children,
}: {
  theme: Theme;
  title?: string;
  label?: string;
  summary?: string;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={{ borderTopWidth: 1, borderColor: theme.colors.border }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label ?? title}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        style={({ pressed }) => ({
          paddingVertical: 14,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <Icon
          name={expanded ? "ChevronDown" : "ChevronRight"}
          size={16}
          color={theme.colors.foregroundMuted}
        />
        <View style={{ flex: 1, gap: 3 }}>
          <Text
            style={{
              fontSize: 14,
              fontWeight: "500",
              color: theme.colors.foreground,
            }}
          >
            {title}
          </Text>
          {summary && !expanded && (
            <Text style={{ fontSize: 14, color: theme.colors.foregroundMuted }}>
              {summary}
            </Text>
          )}
        </View>
      </Pressable>
      {expanded && (
        <View style={{ gap: 16, paddingBottom: 6 }}>{children}</View>
      )}
    </View>
  );
}
export function Badge({
  theme,
  label,
  tone = "muted",
  alignSelf = "flex-start",
}: {
  theme: Theme;
  label: string;
  tone?: "muted" | "success" | "warning";
  /** Use "center" when the badge sits in an alignItems:center row. */
  alignSelf?: "flex-start" | "center";
}) {
  const color =
    tone === "success"
      ? theme.colors.statusSuccess
      : tone === "warning"
        ? theme.colors.statusWarning
        : theme.colors.foregroundMuted;
  return (
    <View
      style={{
        paddingHorizontal: 9,
        paddingVertical: 5,
        borderRadius: 6,
        backgroundColor: theme.colors.surface2,
        alignSelf,
      }}
    >
      <Text style={{ fontSize: 13, lineHeight: 17, color, fontWeight: "500" }}>
        {label}
      </Text>
    </View>
  );
}
export function Card({
  theme,
  title,
  icon,
  description,
  badge,
  grow = false,
  children,
}: {
  theme: Theme;
  title: string;
  icon: string;
  description: string;
  badge?: ReactNode;
  grow?: boolean;
  children: ReactNode;
}) {
  return (
    <View
      style={{
        flex: grow ? 1 : undefined,
        flexShrink: 0,
        minWidth: 0,
        backgroundColor: theme.colors.surface1,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 14,
        padding: 22,
        gap: 20,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}>
        <View
          style={{
            height: 38,
            width: 38,
            borderRadius: 10,
            backgroundColor: theme.colors.surface2,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name={icon} size={20} color={theme.colors.accent} />
        </View>
        <View style={{ flex: 1, gap: 4 }}>
          <Text
            style={{
              fontSize: 18,
              lineHeight: 24,
              fontWeight: "600",
              color: theme.colors.foreground,
            }}
          >
            {title}
          </Text>
          <Text
            style={{
              fontSize: 14,
              lineHeight: 21,
              color: theme.colors.foregroundMuted,
            }}
          >
            {description}
          </Text>
        </View>
        {badge}
      </View>
      {children}
    </View>
  );
}
