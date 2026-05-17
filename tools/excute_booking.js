/**
 * Tool 5: execute_booking
 * ─────────────────────────────────────────────────────────────
 * 职责：按行程逐项执行预约/购票/配送动作，
 *       通过 onProgress 回调实时推送每步进度给 UI。
 *
 * 调用：
 *   const result = await executeBooking(planItems, intent, { onProgress });
 *
 * 返回：
 *   { ok: true,  actions: ActionResult[], summary: string }
 *   { ok: false, actions: ActionResult[], summary: string, errors: string[] }
 *
 * ActionResult：
 *   { id, label, icon, status: 'ok'|'pending'|'failed', detail, duration_ms }
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

// ── 动作类型定义 ──────────────────────────────────────────────
var ACTION_TYPES = {
  RESERVE_RESTAURANT: 'reserve_restaurant',
  BUY_TICKET:         'buy_ticket',
  CHECK_AVAILABILITY: 'check_availability',
  ORDER_EXTRAS:       'order_extras',
  SEND_PLAN:          'send_plan'
};

// ── 动作模板库（按 category + 场景生成动作列表）──────────────
function buildActions(planItems, intent) {
  var actions = [];
  var idCounter = 1;

  function makeId() { return 'act_' + (idCounter++); }

  planItems.forEach(function(item) {
    if (item.category === 'restaurant') {
      // ① 餐厅预约（有 reservable 则先预约，否则叫号）
      if (item.reservable) {
        actions.push({
          id:       makeId(),
          type:     ACTION_TYPES.RESERVE_RESTAURANT,
          icon:     '🍽️',
          label:    item.name + ' — ' + intent.adults + '人位预约',
          detail:   '预约 ' + (item.arrival_time || '') + ' 到店，' + intent.adults + ' 位，靠窗优先',
          place_id: item.id,
          delay_ms: 600,
          retry:    1
        });
      } else {
        actions.push({
          id:       makeId(),
          type:     ACTION_TYPES.CHECK_AVAILABILITY,
          icon:     '🔢',
          label:    item.name + ' — 查询当前等位',
          detail:   '实时查询等候桌数和预计等位时长',
          place_id: item.id,
          delay_ms: 300,
          retry:    0
        });
      }
    }

    if (item.category === 'activity') {
      if (item.ticket_price > 0) {
        // ② 购票（收费景点）
        actions.push({
          id:       makeId(),
          type:     ACTION_TYPES.BUY_TICKET,
          icon:     '🎫',
          label:    item.name + ' — 门票 ¥' + item.ticket_price + '/张 × ' + (intent.adults + (intent.children ? intent.children.length : 0)),
          detail:   '成人票 ¥' + item.ticket_price + '/张，电子票即时出票',
          place_id: item.id,
          delay_ms: 500,
          retry:    1
        });
      } else {
        // ③ 免费景点，仅确认开放状态
        actions.push({
          id:       makeId(),
          type:     ACTION_TYPES.CHECK_AVAILABILITY,
          icon:     '✅',
          label:    item.name + ' — 确认今日开放',
          detail:   '免费入场，确认当日开放时间及人流情况',
          place_id: item.id,
          delay_ms: 200,
          retry:    0
        });
      }
    }
  });

  // ④ 特殊需求：健康饮食 → 询问轻食/低卡推荐
  if (intent.special_needs && intent.special_needs.includes('健康饮食')) {
    var rstItem = planItems.find(function(p) { return p.category === 'restaurant'; });
    if (rstItem) {
      actions.push({
        id:       makeId(),
        type:     ACTION_TYPES.ORDER_EXTRAS,
        icon:     '🥗',
        label:    rstItem.name + ' — 备注健康饮食需求',
        detail:   '向餐厅备注：少油少盐，优先推荐轻食菜品',
        place_id: rstItem.id,
        delay_ms: 300,
        retry:    0
      });
    }
  }

  // ⑤ 有孩子 → 询问儿童椅/儿童餐
  if (intent.children && intent.children.length > 0) {
    var rstItem2 = planItems.find(function(p) { return p.category === 'restaurant'; });
    if (rstItem2 && rstItem2.kid_menu) {
      actions.push({
        id:       makeId(),
        type:     ACTION_TYPES.ORDER_EXTRAS,
        icon:     '👶',
        label:    rstItem2.name + ' — 预订儿童椅 × ' + intent.children.length,
        detail:   '为 ' + intent.children.length + ' 位小朋友预留儿童椅和儿童餐具',
        place_id: rstItem2.id,
        delay_ms: 250,
        retry:    0
      });
    }
  }

  // ⑥ 最后一步：发送行程给同行者
  actions.push({
    id:       makeId(),
    type:     ACTION_TYPES.SEND_PLAN,
    icon:     '📱',
    label:    '行程计划 — 发送给同行者',
    detail:   '生成出行摘要，一键发送给同行的家人/朋友',
    place_id: null,
    delay_ms: 400,
    retry:    0
  });

  return actions;
}

// ── 主函数 ────────────────────────────────────────────────────
async function executeBooking(planItems, intent, options) {
  options = options || {};
  var onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  var mockMode   = options.mockMode !== false; // 默认 mock

  var actions    = buildActions(planItems, intent);
  var results    = [];
  var hasFailure = false;

  for (var i = 0; i < actions.length; i++) {
    var action = actions[i];

    // 推送"执行中"状态
    if (onProgress) {
      onProgress({
        action:  action,
        status:  'running',
        index:   i,
        total:   actions.length
      });
    }

    var result = await runAction(action, mockMode);

    // 失败时最多重试一次
    if (result.status === 'failed' && action.retry > 0) {
      await delay_ms_fn(300);
      result = await runAction(action, mockMode);
      result.retried = true;
    }

    results.push(result);
    if (result.status === 'failed') hasFailure = true;

    // 推送最终状态
    if (onProgress) {
      onProgress({
        action:  action,
        result:  result,
        status:  result.status,
        index:   i,
        total:   actions.length
      });
    }

    // 每步之间短暂停顿，让用户看清进度
    if (i < actions.length - 1) await delay_ms_fn(120);
  }

  var summary = buildExecutionSummary(results, planItems, intent);

  return {
    ok:      !hasFailure,
    actions: results,
    summary: summary,
    errors:  results.filter(function(r) { return r.status === 'failed'; })
                    .map(function(r) { return r.label + '：' + r.error; })
  };
}

// ── 单个动作执行 ──────────────────────────────────────────────
async function runAction(action, mockMode) {
  var t0 = Date.now();

  // Mock 模式：模拟延迟 + 随机失败率（5%）
  await delay_ms_fn(action.delay_ms);

  var failed = mockMode && Math.random() < 0.05; // 5% 失败率

  if (failed) {
    return {
      id:          action.id,
      type:        action.type,
      icon:        action.icon,
      label:       action.label,
      detail:      action.detail,
      status:      'failed',
      error:       '网络超时，请稍后手动确认',
      duration_ms: Date.now() - t0
    };
  }

  // Mock 成功：根据动作类型生成不同的成功详情
  var successDetail = buildSuccessDetail(action);

  return {
    id:          action.id,
    type:        action.type,
    icon:        action.icon,
    label:       action.label,
    detail:      successDetail,
    status:      'ok',
    duration_ms: Date.now() - t0
  };
}

// ── 成功详情文案 ──────────────────────────────────────────────
function buildSuccessDetail(action) {
  switch (action.type) {
    case ACTION_TYPES.RESERVE_RESTAURANT:
      return '预约成功 ✓ 订单号 MT' + Math.random().toString(36).slice(2,8).toUpperCase();
    case ACTION_TYPES.BUY_TICKET:
      return '购票成功 ✓ 电子票已发至手机，凭码入场';
    case ACTION_TYPES.CHECK_AVAILABILITY:
      var wait = Math.floor(Math.random() * 20);
      return wait === 0 ? '当前无需等候，随时可入场 ✓' : '当前等候约 ' + wait + ' 分钟';
    case ACTION_TYPES.ORDER_EXTRAS:
      return '备注已提交 ✓ 餐厅已确认收到';
    case ACTION_TYPES.SEND_PLAN:
      return '已发送给同行者 ✓ 他们将收到出行提醒';
    default:
      return '操作成功 ✓';
  }
}

// ── 执行摘要文案 ──────────────────────────────────────────────
function buildExecutionSummary(results, planItems, intent) {
  var okCount   = results.filter(function(r) { return r.status === 'ok'; }).length;
  var failCount = results.filter(function(r) { return r.status === 'failed'; }).length;

  var firstStop = planItems[0];
  var startTime = firstStop ? firstStop.arrival_time : '14:00';

  var groupMap  = { family: '家人', friends: '朋友们', couple: '另一半', senior: '长辈' };
  var groupWord = (intent && groupMap[intent.group_type]) || '大家';

  if (failCount === 0) {
    return '🎉 全部搞定！' + okCount + '项预约均已完成。' +
           startTime + ' 和' + groupWord + '出发，祝玩得开心！';
  }
  return '⚠️ ' + okCount + '项成功，' + failCount + '项需手动确认。' +
         '行程不受影响，' + startTime + ' 准时出发！';
}

// ── 工具 ──────────────────────────────────────────────────────
function delay_ms_fn(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// ── 导出（双环境兼容）────────────────────────────────────────
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { executeBooking, buildActions, runAction, buildExecutionSummary };
}