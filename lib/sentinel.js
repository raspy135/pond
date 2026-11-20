// Sentinel — Muse-style out-of-band permission & approval gate for side-effecting tools.
import { CONFIG, saveRuntimeSettings } from './config.js';
import { readJson, updateJson, uid, logActivity } from './storage.js';
import { broadcast, pushNotification } from './notifications.js';
import { pluginToolHasSideEffects } from './plugins.js';

// In-memory live waiters for pending approvals: id -> { resolve, timer }
const pendingWaiters = new Map();
// Session-scoped approvals (reset on server restart)
const sessionApprovedKeys = new Set();

export function getPolicyKey(toolName, args = {}) {
  if (toolName.startsWith('mcp_') || toolName === 'connect_mcp') return 'mcp_tool';
  if (toolName === 'edit_file') return 'write_file'; // same permission as writing
  if (toolName === 'update_settings' && args.sentinel) return 'update_sentinel'; // the AI changing its own guard rails
  if (toolName === 'update_settings' && (args.persona || args.assistantName !== undefined)) return 'update_persona';
  if (toolName === 'http_request') {
    const method = String(args.method || 'GET').toUpperCase();
    return method === 'GET' || method === 'HEAD' ? 'http_request_read' : 'http_request_write';
  }
  return toolName;
}

export function getPolicy(toolName, args = {}) {
  if (!CONFIG.sentinel.enabled) return 'allow';
  const key = getPolicyKey(toolName, args);
  const policies = CONFIG.sentinel.policies || {};
  if (key === 'update_persona') return policies.update_persona || 'ask'; // more specific than update_settings
  if (key === 'update_sentinel') return policies.update_sentinel === 'deny' ? 'deny' : 'ask'; // never silent
  if (policies[toolName]) return policies[toolName];
  if (policies[key]) return policies[key];
  if (toolName.startsWith('plugin_') && pluginToolHasSideEffects(toolName)) return policies.plugin_tool || 'ask';
  return 'allow';
}

function summarizeAction(toolName, args = {}) {
  switch (toolName) {
    case 'send_email':
      return `Send email to ${args.to || '?'} — "${String(args.subject || '').slice(0, 80)}"`;
    case 'update_settings':
      if (args.persona || args.assistantName !== undefined) {
        const p = args.persona || {};
        return `Change personality${args.assistantName ? ` (name: ${args.assistantName})` : ''}: ${p.preset || ''}${p.custom ? ` — "${String(p.custom).slice(0, 120)}"` : ''}`;
      }
      return `Update Pond settings: ${Object.keys(args).join(', ')}`;
    case 'save_skill':
      return `Save skill "${args.name || '?'}" — ${String(args.description || '').slice(0, 100)}${args.from_artifact_id ? ` (+ template from artifact ${args.from_artifact_id})` : ''}`;
    case 'delete_skill':
      return `Delete skill "${args.name || '?'}"`;
    case 'delete_file':
      return `Delete file "${args.path || '?'}"`;
    case 'write_file':
      return `Write file "${args.path || '?'}" (${String(args.content || '').length} chars)`;
    case 'edit_file': {
      const n = Array.isArray(args.edits) && args.edits.length ? args.edits.length : 1;
      return `Edit file "${args.path || '?'}" (${n} change${n === 1 ? '' : 's'})`;
    }
    case 'run_command':
      return `Run ${process.platform === 'win32' ? 'PowerShell' : 'shell'} command: ${String(args.command || '').slice(0, 300)}`;
    case 'run_python': {
      const lines = String(args.code || '').trim().split('\n');
      const first = (lines[0] || '').slice(0, 80);
      return `Run Python script (${lines.length} line${lines.length === 1 ? '' : 's'}): ${first}`;
    }
    case 'http_request':
      return `${String(args.method || 'POST').toUpperCase()} ${String(args.url || '').slice(0, 120)}`;
    default:
      return `Run tool ${toolName}(${JSON.stringify(args).slice(0, 120)})`;
  }
}

export async function listApprovals() {
  const list = await readJson('approvals.json', []);
  return Array.isArray(list) ? list : [];
}

export async function listPendingApprovals() {
  const list = await listApprovals();
  return list.filter((a) => a.status === 'pending');
}

export async function requestApproval(toolName, args = {}, context = {}) {
  const policyKey = getPolicyKey(toolName, args);
  const policy = getPolicy(toolName, args);

  if (policy === 'allow') return { allowed: true };
  if (policy === 'deny') {
    await logActivity({
      kind: 'sentinel',
      level: 'warn',
      title: `Blocked ${toolName}`,
      detail: `Denied by Sentinel policy (${policyKey})`,
    });
    return { allowed: false, reason: `Blocked by Sentinel policy: "${policyKey}" is set to deny.` };
  }
  if (sessionApprovedKeys.has(policyKey) || sessionApprovedKeys.has(toolName)) {
    return { allowed: true, scope: 'session' };
  }

  const approval = {
    id: uid(),
    tool: toolName,
    policyKey,
    summary: summarizeAction(toolName, args),
    args,
    source: context.source || 'chat', // chat | proactive | job | task | subagent
    status: 'pending',
    createdAt: new Date().toISOString(),
  };

  await updateJson('approvals.json', [], (list) => {
    const arr = Array.isArray(list) ? list : [];
    arr.unshift(approval);
    return arr.slice(0, 100);
  });

  await logActivity({
    kind: 'sentinel',
    level: 'warn',
    title: `Approval requested: ${toolName}`,
    detail: approval.summary,
    meta: { approvalId: approval.id },
  });

  broadcast({ type: 'approval_required', approval });
  await pushNotification({
    title: `🛡️ Approval needed — ${CONFIG.assistantName}`,
    body: approval.summary,
    urgency: 'critical',
    category: 'approval',
    tag: `approval-${approval.id}`,
    meta: { approvalId: approval.id, tool: toolName },
  });

  const timeoutMs = Math.max(30, CONFIG.sentinel.approvalTimeoutSec || 300) * 1000;

  return new Promise((resolve) => {
    const timer = setTimeout(async () => {
      pendingWaiters.delete(approval.id);
      await updateJson('approvals.json', [], (list) =>
        (Array.isArray(list) ? list : []).map((a) =>
          a.id === approval.id && a.status === 'pending'
            ? { ...a, status: 'expired', decidedAt: new Date().toISOString() }
            : a
        )
      );
      broadcast({ type: 'approval_resolved', id: approval.id, status: 'expired' });
      resolve({ allowed: false, reason: 'Approval request timed out before user responded.' });
    }, timeoutMs);

    pendingWaiters.set(approval.id, { resolve, timer, approval });
  });
}

export async function decideApproval(id, decision) {
  // decision: approve_once | approve_session | approve_always | deny
  const waiter = pendingWaiters.get(id);
  const approvals = await listApprovals();
  const target = waiter?.approval || approvals.find((a) => a.id === id);
  if (!target) return { ok: false, error: 'Approval not found' };

  const approved = decision !== 'deny';
  const status = approved ? 'approved' : 'denied';

  if (decision === 'approve_session') {
    sessionApprovedKeys.add(target.policyKey);
  } else if (decision === 'approve_always') {
    sessionApprovedKeys.add(target.policyKey);
    await saveRuntimeSettings({ sentinel: { policies: { [target.policyKey]: 'allow' } } });
  }

  await updateJson('approvals.json', [], (list) =>
    (Array.isArray(list) ? list : []).map((a) =>
      a.id === id ? { ...a, status, decision, decidedAt: new Date().toISOString() } : a
    )
  );

  await logActivity({
    kind: 'sentinel',
    level: approved ? 'info' : 'warn',
    title: `Sentinel ${status}: ${target.tool}`,
    detail: `${target.summary} (${decision})`,
  });

  broadcast({ type: 'approval_resolved', id, status, decision });

  if (waiter) {
    clearTimeout(waiter.timer);
    pendingWaiters.delete(id);
    waiter.resolve(
      approved
        ? { allowed: true, decision }
        : { allowed: false, reason: 'User denied this action via Sentinel.' }
    );
  }

  return { ok: true, id, status, decision };
}
