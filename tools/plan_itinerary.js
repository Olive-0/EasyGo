/**
 * Tool 4: plan_itinerary
 * ─────────────────────────────────────────────────────────────
 * 职责：把 Tool2 活动候选 + Tool3 餐厅候选交给 AI，
 *       生成一份时间排布合理、逻辑连贯的三段式行程。
 *
 * 调用：
 *   const result = await planItinerary(intent, activities, restaurants, apiConfig);
 *
 * 返回：
 *   { ok: true,  planItems: PlannedItem[], summary: string, source: string }
 *   { ok: false, error: string, planItems: PlannedItem[] }  ← 降级结果
 *
 * PlannedItem 格式与 showPlanCards() 完全兼容（扩展自 Tool2/3 输出）
 * ─────────────────────────────────────────────────────────────
 */

// ── System Prompt ─────────────────────────────────────────────
const PLAN_SYSTEM_PROMPT =
  '你是美团本地出行规划助手，擅长为用户安排合理的周末行程。\n' +
  '你会收到一份结构化的用户意图 + 活动候选列表 + 餐厅候选列表。\n' +
  '请从候选列表中挑选最合适的组合，安排一份"活动→餐厅→活动/休闲"三段式行程。\n' +
  '\n' +
  '输出要求（只输出 JSON，不要任何解释或 markdown 代码块）：\n' +
  '{\n' +
  '  "stops": [\n' +
  '    { "place_id": "<候选列表中的 id>", "arrival": "HH:MM", "duration_min": <整数>, "reason": "<一句话推荐理由>" },\n' +
  '    ...\n' +
  '  ],\n' +
  '  "summary": "<2-3句话的行程总结，口语化，像朋友推荐>",\n' +
  '  "total_cost_estimate": <整数，人均预计消费元>\n' +
  '}\n' +
  '\n' +
  '规划规则：\n' +
  '1. stops 必须恰好 3 个：第1站活动、第2站餐厅、第3站活动或休闲\n' +
  '2. 每个 place_id 必须来自候选列表，不能捏造\n' +
  '3. 时间要连贯：arrival + duration_min = 下一站 arrival（允许15分钟交通缓冲）\n' +
  '4. 有孩子时优先选 child_friendly 的活动和有 kid_menu 的餐厅\n' +
  '5. 健康饮食需求时优先选 healthy_score ≥ 4 的餐厅\n' +
  '6. 总时长控制在用户期望的 duration_hours 以内\n' +
  '7. summary 要温暖有人情味，不要机械地列出地名\n' +
  '只输出合法 JSON，不要输出任何其他内容。';

// ── LongCat API（OpenAI 兼容格式）─────────────────────────────
const LONGCAT_API_URL = 'https://api.longcat.ai/v1/chat/completions';
const LONGCAT_MODEL   = 'longcat-chat';   // 按实际模型名填写

// ── 主函数 ────────────────────────────────────────────────────
async function planItinerary(intent, activities, restaurants, apiConfig) {
  const cfg = apiConfig || window.APP_CONFIG || {};

  // 构建给 AI 的候选列表（精简字段，节省 token）
  const actCandidates = activities.slice(0, 5).map(function(a) {
    return {
      id: a.id, name: a.name, type: a.type,
      tags: a.tags, rating: a.rating,
      distance_km: a.distance_km, duration_min: a.duration_min,
      price_text: a.price_text, availability: a.availability
    };
  });
  const rstCandidates = restaurants.slice(0, 4).map(function(r) {
    return {
      id: r.id, name: r.name, cuisine: r.cuisine,
      tags: r.tags, rating: r.rating,
      wait_text: r.wait_text, reservable: r.reservable,
      price_text: r.price_text, healthy_score: r.healthy_score,
      kid_menu: r.kid_menu
    };
  });

  const userPrompt =
    '用户意图：' + JSON.stringify({
      group_type:     intent.group_type,
      adults:         intent.adults,
      children:       intent.children,
      start_time:     intent.start_time,
      duration_hours: intent.duration_hours,
      preferences:    intent.preferences,
      special_needs:  intent.special_needs
    }) + '\n\n' +
    '活动候选（从这里选第1、3站）：\n' + JSON.stringify(actCandidates, null, 2) + '\n\n' +
    '餐厅候选（从这里选第2站）：\n' + JSON.stringify(rstCandidates, null, 2);

  // ── 依次尝试各 AI ──────────────────────────────────────────
  const primaryModel = cfg.PRIMARY_AI_MODEL || 'zhipu';
  const fallbackOrder = cfg.AI_FALLBACK_ORDER ||
    [primaryModel, 'zhipu', 'deepseek', 'longcat'].filter(
      function(v, i, a) { return a.indexOf(v) === i; }
    );

  let aiResponse = null;
  let usedModel  = null;
  let lastError  = null;

  for (var mi = 0; mi < fallbackOrder.length; mi++) {
    var modelName = fallbackOrder[mi];
    try {
      if (modelName === 'zhipu' && cfg.ZHIPU_API_KEY) {
        aiResponse = await callAI_GLM(PLAN_SYSTEM_PROMPT, userPrompt, cfg.ZHIPU_API_KEY);
        usedModel  = 'GLM-4-Flash';
        break;
      }
      if (modelName === 'deepseek' && cfg.DEEPSEEK_API_KEY) {
        aiResponse = await callAI_DeepSeek(PLAN_SYSTEM_PROMPT, userPrompt, cfg.DEEPSEEK_API_KEY);
        usedModel  = 'DeepSeek';
        break;
      }
      if (modelName === 'longcat' && cfg.LONGCAT_API_KEY) {
        aiResponse = await callAI_LongCat(PLAN_SYSTEM_PROMPT, userPrompt, cfg.LONGCAT_API_KEY);
        usedModel  = 'LongCat';
        break;
      }
    } catch (err) {
      lastError = err;
      debugLog('planItinerary', modelName + ' 失败: ' + err.message);
    }
  }

  // ── 解析 AI 输出 ───────────────────────────────────────────
  if (aiResponse) {
    try {
      var parsed = parsePlanJSON(aiResponse);
      var planItems = buildPlanItems(parsed.stops, activities, restaurants, intent);
      if (planItems.length >= 2) {
        return {
          ok:        true,
          planItems: planItems,
          summary:   parsed.summary || '',
          cost:      parsed.total_cost_estimate || null,
          source:    usedModel
        };
      }
    } catch (parseErr) {
      debugLog('planItinerary', 'JSON解析失败: ' + parseErr.message + '\n原文: ' + aiResponse.slice(0, 200));
    }
  }

  // ── 降级：规则引擎 ─────────────────────────────────────────
  debugLog('planItinerary', '使用规则降级，原因: ' + (lastError ? lastError.message : 'AI解析失败'));
  var fallbackItems = buildFallbackPlan(activities, restaurants, intent);
  return {
    ok:        false,
    planItems: fallbackItems,
    summary:   buildFallbackSummary(fallbackItems, intent),
    cost:      null,
    source:    'fallback',
    error:     lastError ? lastError.message : 'AI输出解析失败'
  };
}

// ── GLM-4-Flash 调用 ──────────────────────────────────────────
async function callAI_GLM(systemPrompt, userPrompt, apiKey) {
  var res = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': 'Bearer ' + apiKey
    },
    body: JSON.stringify({
      model:       'glm-4-flash',
      max_tokens:  800,
      temperature: 0.3,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   }
      ]
    }),
    signal: AbortSignal.timeout(12000)
  });
  if (!res.ok) {
    var errBody = await res.text();
    throw new Error('GLM HTTP ' + res.status + ': ' + errBody.slice(0, 150));
  }
  var data = await res.json();
  return (data.choices && data.choices[0] && data.choices[0].message)
    ? data.choices[0].message.content
    : '';
}

// ── DeepSeek 调用 ─────────────────────────────────────────────
async function callAI_DeepSeek(systemPrompt, userPrompt, apiKey) {
  var res = await fetch('https://api.deepseek.com/chat/completions', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': 'Bearer ' + apiKey
    },
    body: JSON.stringify({
      model:       'deepseek-chat',
      max_tokens:  800,
      temperature: 0.3,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   }
      ]
    }),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) {
    var errBody = await res.text();
    throw new Error('DeepSeek HTTP ' + res.status + ': ' + errBody.slice(0, 150));
  }
  var data = await res.json();
  return (data.choices && data.choices[0] && data.choices[0].message)
    ? data.choices[0].message.content
    : '';
}

// ── LongCat 调用（OpenAI 兼容格式）──────────────────────────
async function callAI_LongCat(systemPrompt, userPrompt, apiKey) {
  var res = await fetch(LONGCAT_API_URL, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': 'Bearer ' + apiKey
    },
    body: JSON.stringify({
      model:       LONGCAT_MODEL,
      max_tokens:  800,
      temperature: 0.3,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   }
      ]
    }),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) {
    var errBody = await res.text();
    throw new Error('LongCat HTTP ' + res.status + ': ' + errBody.slice(0, 150));
  }
  var data = await res.json();
  return (data.choices && data.choices[0] && data.choices[0].message)
    ? data.choices[0].message.content
    : '';
}

// ── JSON 解析（健壮版）────────────────────────────────────────
function parsePlanJSON(raw) {
  if (!raw) throw new Error('空响应');

  // 去掉 markdown 代码块包裹
  var cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i,     '')
    .replace(/```\s*$/i,     '')
    .trim();

  // 提取第一个 {...} 块
  var start = cleaned.indexOf('{');
  var end   = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('响应中找不到 JSON 对象');
  cleaned = cleaned.slice(start, end + 1);

  var obj = JSON.parse(cleaned);

  // 基础结构校验
  if (!Array.isArray(obj.stops))       throw new Error('stops 字段不是数组');
  if (obj.stops.length < 2)            throw new Error('stops 少于 2 个');
  obj.stops.forEach(function(s, i) {
    if (!s.place_id) throw new Error('stops[' + i + '] 缺少 place_id');
    if (!s.arrival)  throw new Error('stops[' + i + '] 缺少 arrival');
  });

  return obj;
}

// ── 把 AI 的 stops 映射回真实 Item 对象 ───────────────────────
function buildPlanItems(stops, activities, restaurants, intent) {
  var allCandidates = activities.concat(restaurants);
  var items = [];

  stops.forEach(function(stop) {
    var found = allCandidates.find(function(c) { return c.id === stop.place_id; });
    if (!found) {
      debugLog('planItinerary', 'place_id 不在候选列表: ' + stop.place_id);
      return;
    }

    // 用 AI 给出的时间覆盖 Tool2/3 计算的默认时间
    var item = Object.assign({}, found);
    item.arrival_time = stop.arrival;

    // 重新计算 time_range（arrival + duration）
    var arrMins   = timeToMinutes(stop.arrival);
    var durMins   = stop.duration_min || found.duration_min || 60;
    var endTime   = minutesToTimeStr(arrMins + durMins);
    item.time_range   = stop.arrival + ' - ' + endTime;
    item.duration_min = durMins;
    item.duration_text = durMins >= 60
      ? (durMins / 60) + '小时'
      : durMins + '分钟';

    // 附加 AI 的推荐理由（用于卡片描述增强）
    if (stop.reason) {
      item.ai_reason = stop.reason;
      item.desc      = stop.reason + ' · ' + (found.desc || '');
    }

    items.push(item);
  });

  return items;
}

// ── 规则降级：按评分直接取最优组合 ──────────────────────────
function buildFallbackPlan(activities, restaurants, intent) {
  // 取评分最高的活动 × 2 + 等位最短的餐厅 × 1
  var sortedAct = activities.slice().sort(function(a, b) {
    return (b.score || 0) - (a.score || 0);
  });
  var sortedRst = restaurants.slice().sort(function(a, b) {
    return (a.wait_minutes || 0) - (b.wait_minutes || 0);
  });

  var act1 = sortedAct[0];
  var rst  = sortedRst[0];
  var act2 = sortedAct[1] || sortedAct[0];

  if (!act1 || !rst) return (activities.concat(restaurants)).slice(0, 3);

  // 重新计算时间轴
  var startMins = timeToMinutes(intent.start_time || '14:00');
  act1 = Object.assign({}, act1, {
    arrival_time: minutesToTimeStr(startMins),
    time_range:   minutesToTimeStr(startMins) + ' - ' +
                  minutesToTimeStr(startMins + (act1.duration_min || 90))
  });

  var rstStart = startMins + (act1.duration_min || 90) + 15; // 15分钟交通
  rst = Object.assign({}, rst, {
    arrival_time: minutesToTimeStr(rstStart),
    time_range:   minutesToTimeStr(rstStart) + ' - ' +
                  minutesToTimeStr(rstStart + 90)
  });

  var act2Start = rstStart + 90 + 15;
  act2 = Object.assign({}, act2, {
    arrival_time: minutesToTimeStr(act2Start),
    time_range:   minutesToTimeStr(act2Start) + ' - ' +
                  minutesToTimeStr(act2Start + (act2.duration_min || 60))
  });

  return [act1, rst, act2];
}

// ── 降级文案生成 ───────────────────────────────────────────────
function buildFallbackSummary(planItems, intent) {
  if (!planItems || planItems.length === 0) return '为您安排了一份轻松的行程，出发吧！';
  var groupMap = { family: '一家人', friends: '大家', couple: '你们', senior: '老人家' };
  var group = groupMap[intent.group_type] || '大家';
  var names = planItems.map(function(p) { return p.name; });
  return group + '先去' + (names[0] || '') + '，然后在' +
    (names[1] || '') + '好好吃一顿，最后去' + (names[2] || '') +
    '放松一下，一天安排得刚刚好！';
}

// ── 时间工具 ───────────────────────────────────────────────────
function timeToMinutes(timeStr) {
  var parts = (timeStr || '14:00').split(':');
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1] || '0', 10);
}

function minutesToTimeStr(totalMinutes) {
  var h = Math.floor(totalMinutes / 60) % 24;
  var m = totalMinutes % 60;
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
}

// ── 调试日志 ───────────────────────────────────────────────────
function debugLog(tag, msg) {
  var cfg = (typeof window !== 'undefined' && window.APP_CONFIG) || {};
  if (cfg.DEBUG_MODE) {
    console.log('[' + tag + ']', msg);
  }
}