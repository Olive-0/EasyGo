/**
 * Tool 4: plan_itinerary
 * 职责：activities + restaurants 候选 → AI 组合成带时间轴的三段行程
 * 返回：{ ok, plan: ItineraryPlan, source: 'zhipu'|'deepseek'|'longcat'|'rule' }
 */

const PLAN_GLM_URL      = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const PLAN_DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const PLAN_LONGCAT_URL  = 'https://api.longcat.ai/v1/chat/completions';
const PLAN_GLM_MODEL      = 'glm-4-flash';
const PLAN_DEEPSEEK_MODEL = 'deepseek-chat';
const PLAN_LONGCAT_MODEL  = 'longcat-plus';

// ── System Prompt ─────────────────────────────────────────────
function buildPlanSystemPrompt() {
  return '你是美团本地出行规划助手的行程编排模块。\n' +
    '你会收到：用户出行意图(intent) + 活动候选列表(activities) + 餐厅候选列表(restaurants)。\n' +
    '从候选中挑选最合适的组合，编排"活动→餐厅→活动"三段行程。\n\n' +
    '只输出合法 JSON，不要任何解释或 markdown 代码块，严格按以下结构：\n' +
    '{\n' +
    '  "stops": [\n' +
    '    {"order":1,"id":"<候选id>","name":"<名称>","category":"activity","arrival_time":"HH:MM","end_time":"HH:MM","reason":"<选择理由15字内>"},\n' +
    '    {"order":2,"id":"<候选id>","name":"<名称>","category":"restaurant","arrival_time":"HH:MM","end_time":"HH:MM","reason":"<选择理由15字内>"},\n' +
    '    {"order":3,"id":"<候选id>","name":"<名称>","category":"activity","arrival_time":"HH:MM","end_time":"HH:MM","reason":"<选择理由15字内>"}\n' +
    '  ],\n' +
    '  "summary": "<20-40字口语化行程摘要>",\n' +
    '  "total_cost_estimate": <人均费用整数>,\n' +
    '  "tips": ["<提示1>","<提示2>"]\n' +
    '}\n\n' +
    '编排规则：\n' +
    '1. 第1站和第3站必须从activities中选，第2站必须从restaurants中选\n' +
    '2. 第2站arrival_time = 第1站end_time + 15分钟缓冲\n' +
    '3. 第3站arrival_time = 第2站end_time + 15分钟缓冲\n' +
    '4. 有孩子时优先选kid_menu=true餐厅和亲子活动\n' +
    '5. 有健康饮食需求时优先选healthy_score>=4餐厅\n' +
    '6. 控制总时长在intent.duration_hours小时以内\n' +
    '7. total_cost_estimate = 餐厅price_per_person * adults + 活动ticket_price * adults';
}

// ── 构建精简上下文（节省 token） ──────────────────────────────
function buildContext(intent, activities, restaurants) {
  const intentSlim = {
    group_type: intent.group_type, adults: intent.adults,
    children: intent.children, start_time: intent.start_time,
    duration_hours: intent.duration_hours,
    special_needs: intent.special_needs, preferences: intent.preferences
  };
  const actSlim = activities.slice(0, 6).map(function(a) {
    return { id: a.id, name: a.name, type: a.type,
             duration_min: a.duration_min, rating: a.rating,
             ticket_price: a.ticket_price, tags: a.tags.slice(0, 3) };
  });
  const rstSlim = restaurants.slice(0, 5).map(function(r) {
    return { id: r.id, name: r.name, cuisine: r.cuisine,
             price_per_person: r.price_per_person, healthy_score: r.healthy_score,
             kid_menu: r.kid_menu, wait_text: r.wait_text,
             reservable: r.reservable, rating: r.rating };
  });
  return JSON.stringify({ intent: intentSlim, activities: actSlim, restaurants: rstSlim });
}

// ── 主函数 ────────────────────────────────────────────────────
async function planItinerary(intent, activities, restaurants, options) {
  options = options || {};
  var glmApiKey      = options.glmApiKey      || '';
  var deepseekApiKey = options.deepseekApiKey  || '';
  var longcatApiKey  = options.longcatApiKey   || '';
  var onStream       = options.onStream        || null;

  var context = buildContext(intent, activities, restaurants);
  var systemPrompt = buildPlanSystemPrompt();

  // 构建尝试链（有 key 的才加入）
  var providers = [];
  if (glmApiKey)      providers.push({ name: 'zhipu',    fn: function() { return callAI(PLAN_GLM_URL,      PLAN_GLM_MODEL,      glmApiKey,      systemPrompt, context, onStream); } });
  if (deepseekApiKey) providers.push({ name: 'deepseek', fn: function() { return callAI(PLAN_DEEPSEEK_URL, PLAN_DEEPSEEK_MODEL, deepseekApiKey, systemPrompt, context, null);     } });
  if (longcatApiKey)  providers.push({ name: 'longcat',  fn: function() { return callAI(PLAN_LONGCAT_URL,  PLAN_LONGCAT_MODEL,  longcatApiKey,  systemPrompt, context, null);     } });

  var lastError = null;

  for (var i = 0; i < providers.length; i++) {
    var provider = providers[i];
    try {
      var raw  = await provider.fn();
      var plan = parsePlanJSON(raw);
      validatePlan(plan, activities, restaurants);
      var enriched = enrichPlan(plan, activities, restaurants);
      return { ok: true, plan: enriched, source: provider.name };
    } catch (err) {
      console.warn('[plan_itinerary] ' + provider.name + ' 失败:', err.message);
      lastError = err;
    }
  }

  // 全部 AI 失败 → 规则降级，仍返回可用结果
  console.warn('[plan_itinerary] 全部 AI 失败，规则降级');
  var fallback = ruleFallbackPlan(intent, activities, restaurants);
  return { ok: false, error: (lastError && lastError.message) || '未知错误', plan: fallback, source: 'rule' };
}

// ── 统一 AI 调用（支持 GLM 流式 + 普通） ─────────────────────
async function callAI(url, model, apiKey, systemPrompt, context, onStream) {
  var useStream = typeof onStream === 'function';
  var res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    },
    body: JSON.stringify({
      model: model,
      max_tokens: 800,
      temperature: 0.4,
      stream: useStream,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: '请根据以下数据编排行程：\n' + context }
      ]
    }),
    signal: AbortSignal.timeout(15000)
  });

  if (!res.ok) {
    var body = await res.text();
    throw new Error(url.includes('bigmodel') ? 'GLM' : url.includes('deepseek') ? 'DeepSeek' : 'LongCat' +
      ' HTTP ' + res.status + ': ' + body.slice(0, 120));
  }

  if (useStream) return await readStream(res, onStream);

  var data = await res.json();
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
}

// ── SSE 流式读取 ──────────────────────────────────────────────
async function readStream(res, onStream) {
  var reader  = res.body.getReader();
  var decoder = new TextDecoder('utf-8');
  var full    = '';

  while (true) {
    var result = await reader.read();
    if (result.done) break;
    var chunk = decoder.decode(result.value, { stream: true });
    var lines = chunk.split('\n');
    for (var j = 0; j < lines.length; j++) {
      var line = lines[j];
      if (!line.startsWith('data: ')) continue;
      var data = line.slice(6).trim();
      if (data === '[DONE]') break;
      try {
        var obj   = JSON.parse(data);
        var piece = (obj.choices && obj.choices[0] && obj.choices[0].delta && obj.choices[0].delta.content) || '';
        if (piece) { full += piece; onStream(piece); }
      } catch (_) {}
    }
  }
  return full;
}

// ── JSON 解析（健壮版） ────────────────────────────────────────
function parsePlanJSON(raw) {
  if (!raw || typeof raw !== 'string') throw new Error('空响应');
  var cleaned = raw
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  var start = cleaned.indexOf('{');
  var end   = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('响应中无 JSON 对象');
  cleaned = cleaned.slice(start, end + 1);
  var obj = JSON.parse(cleaned);
  if (!Array.isArray(obj.stops) || obj.stops.length === 0) throw new Error('stops 字段缺失');
  return obj;
}

// ── 校验 AI 选的 id 是否在候选池里 ───────────────────────────
function validatePlan(plan, activities, restaurants) {
  var actIds = {};
  var rstIds = {};
  activities.forEach(function(a) { actIds[a.id] = true; });
  restaurants.forEach(function(r) { rstIds[r.id] = true; });

  plan.stops.forEach(function(stop) {
    if (stop.category === 'activity'   && !actIds[stop.id])
      throw new Error('无效活动 id: ' + stop.id);
    if (stop.category === 'restaurant' && !rstIds[stop.id])
      throw new Error('无效餐厅 id: ' + stop.id);
    if (stop.arrival_time && !/^\d{2}:\d{2}$/.test(stop.arrival_time))
      throw new Error('arrival_time 格式错误: ' + stop.arrival_time);
  });
}

// ── 数据增强（把精简 stop 合并回完整字段） ─────────────────────
function enrichPlan(plan, activities, restaurants) {
  var actMap = {};
  var rstMap = {};
  activities.forEach(function(a)  { actMap[a.id] = a; });
  restaurants.forEach(function(r) { rstMap[r.id] = r; });

  var enrichedStops = plan.stops.map(function(stop) {
    var base = stop.category === 'activity' ? actMap[stop.id] : rstMap[stop.id];
    if (!base) return stop;
    var merged = Object.assign({}, base, {
      order:        stop.order,
      arrival_time: stop.arrival_time,
      end_time:     stop.end_time || '',
      time_range:   (stop.arrival_time || '') + ' - ' + (stop.end_time || ''),
      reason:       stop.reason || ''
    });
    return merged;
  });

  return {
    stops:               enrichedStops,
    summary:             plan.summary             || '精心为您安排的出行方案',
    total_cost_estimate: plan.total_cost_estimate || 0,
    duration_hours:      plan.duration_hours      || 5,
    tips:                Array.isArray(plan.tips) ? plan.tips : []
  };
}

// ── 规则降级 ──────────────────────────────────────────────────
function ruleFallbackPlan(intent, activities, restaurants) {
  var act1 = activities[0];
  var rst  = restaurants[0];
  var act2 = activities[1] || activities[0];

  if (!act1 || !rst) {
    return { stops: [], summary: '候选数据不足，请重试', total_cost_estimate: 0, tips: [], duration_hours: 5 };
  }

  var parts = (intent.start_time || '14:00').split(':');
  var cursor = parseInt(parts[0]) * 60 + parseInt(parts[1]);

  function pad(total) {
    return String(Math.floor(total / 60) % 24).padStart(2, '0') + ':' +
           String(total % 60).padStart(2, '0');
  }

  var s1Start = pad(cursor);
  cursor += (act1.duration_min || 90);
  var s1End = pad(cursor);
  cursor += 15;
  var s2Start = pad(cursor);
  cursor += 90;
  var s2End = pad(cursor);
  cursor += 15;
  var s3Start = pad(cursor);
  cursor += (act2.duration_min || 60);
  var s3End = pad(cursor);

  var stops = [
    Object.assign({}, act1, { order: 1, arrival_time: s1Start, end_time: s1End, time_range: s1Start + ' - ' + s1End, reason: '综合评分最高' }),
    Object.assign({}, rst,  { order: 2, arrival_time: s2Start, end_time: s2End, time_range: s2Start + ' - ' + s2End, reason: '等位时间最短' }),
    Object.assign({}, act2, { order: 3, arrival_time: s3Start, end_time: s3End, time_range: s3Start + ' - ' + s3End, reason: '饭后休闲好去处' })
  ];

  var costEst = ((rst.price_per_person || 80) + (act1.ticket_price || 0)) * (intent.adults || 2);

  return {
    stops: stops,
    summary: intent.start_time + '出发，先去' + act1.name + '，再去' + rst.name + '用餐，最后' + act2.name + '。',
    total_cost_estimate: costEst,
    tips: ['建议提前查看营业时间', '出发前确认餐厅是否需要预约'],
    duration_hours: intent.duration_hours || 5
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { planItinerary, buildContext, parsePlanJSON, validatePlan, enrichPlan, ruleFallbackPlan };
} else {
  window.planItinerary = planItinerary;
}