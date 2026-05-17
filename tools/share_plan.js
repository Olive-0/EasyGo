/**
 * Tool 6: share_plan
 * ─────────────────────────────────────────────────────────────
 * 职责：把已执行的行程生成多种格式的分享文案
 *
 * 调用：
 *   const share = sharePlan(planItems, intent, bookingResult);
 *
 * 返回：
 *   {
 *     wechat:  string,   // 微信分享格式（带 emoji，换行清晰）
 *     plain:   string,   // TTS 朗读格式（无 emoji，适合语音播报）
 *     compact: string,   // 单行紧凑格式（适合短消息/短链接）
 *     title:   string    // 标题行
 *   }
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

function sharePlan(planItems, intent, bookingResult) {
  var groupMap  = { family: '家人', friends: '朋友们', couple: '另一半', senior: '长辈' };
  var groupWord = (intent && groupMap[intent.group_type]) || '大家';
  var adults    = (intent && intent.adults) || 2;
  var children  = (intent && intent.children && intent.children.length) || 0;
  var headcount = adults + children;

  // 计算行程时间跨度
  var firstStop = planItems[0];
  var lastStop  = planItems[planItems.length - 1];
  var startTime = firstStop ? firstStop.arrival_time : '14:00';
  var endTime   = lastStop
    ? calcEndTime(lastStop.arrival_time, lastStop.duration_min || 60)
    : '20:00';

  // 费用估算（来自 bookingResult 或累加）
  var costNote = '';
  if (bookingResult && bookingResult.actions) {
    // 从行程本身算：餐厅 price × 人数 + 门票
    var totalCost = planItems.reduce(function(sum, item) {
      if (item.category === 'restaurant') return sum + (item.price_per_person || 0) * adults;
      if (item.category === 'activity')   return sum + (item.ticket_price || 0) * headcount;
      return sum;
    }, 0);
    if (totalCost > 0) costNote = '💰 人均约 ¥' + Math.round(totalCost / headcount);
  }

  // ── 微信格式 ────────────────────────────────────────────────
  var wechatLines = [
    '📍 今日出行计划 | ' + headcount + '人 | ' + startTime + '-' + endTime,
    ''
  ];
  planItems.forEach(function(item, i) {
    var stepIcon = item.category === 'restaurant' ? '🍽️' : (i === 0 ? '🎯' : '🎪');
    var stepLine = stepIcon + ' ' + item.arrival_time + '  ' + item.name;
    if (item.category === 'restaurant' && item.wait_text && item.wait_text !== '无需等位') {
      stepLine += '（' + item.wait_text + '）';
    }
    if (item.category === 'activity' && item.ticket_price === 0) {
      stepLine += '（免费）';
    }
    wechatLines.push(stepLine);
    if (item.desc) {
      // 截取描述前 20 字
      var shortDesc = item.desc.length > 20 ? item.desc.slice(0, 20) + '…' : item.desc;
      wechatLines.push('   ' + shortDesc);
    }
    wechatLines.push('');
  });

  if (costNote) wechatLines.push(costNote);
  wechatLines.push('✨ 美团出行规划 · 祝玩得开心！');

  // ── TTS 朗读格式 ──────────────────────────────────────────
  var plainParts = [
    '行程安排好了，' + headcount + '人出行，' + startTime + '出发。'
  ];
  planItems.forEach(function(item, i) {
    var order = ['第一站', '第二站', '第三站', '第四站'][i] || ('第' + (i + 1) + '站');
    plainParts.push(order + '是' + item.name + '，' + item.arrival_time + '到达，');
    if (item.category === 'restaurant') {
      plainParts.push('在这里' + (item.duration_min ? Math.round(item.duration_min / 60 * 10) / 10 : 1) + '小时用餐。');
    } else {
      plainParts.push('游览约' + (item.duration_min ? Math.round(item.duration_min / 60 * 10) / 10 : 1) + '小时。');
    }
  });
  plainParts.push('预计' + endTime + '结束，祝' + groupWord + '玩得开心！');

  // ── 紧凑单行格式 ───────────────────────────────────────────
  var stops = planItems.map(function(item) {
    return item.arrival_time + ' ' + item.name;
  }).join(' → ');
  var compact = '今日行程：' + stops + '（' + headcount + '人）';

  // ── 标题 ──────────────────────────────────────────────────
  var dateStr = getTodayStr();
  var title   = dateStr + ' 和' + groupWord + '的行程';

  return {
    wechat:  wechatLines.join('\n'),
    plain:   plainParts.join(''),
    compact: compact,
    title:   title
  };
}

// ── 工具函数 ─────────────────────────────────────────────────
function calcEndTime(arrivalTime, durationMin) {
  var parts = (arrivalTime || '14:00').split(':');
  var totalMin = parseInt(parts[0], 10) * 60 + parseInt(parts[1] || '0', 10) + durationMin;
  var h = Math.floor(totalMin / 60) % 24;
  var m = totalMin % 60;
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
}

function getTodayStr() {
  var now = new Date();
  var month = now.getMonth() + 1;
  var day   = now.getDate();
  var weeks = ['日','一','二','三','四','五','六'];
  return month + '月' + day + '日（周' + weeks[now.getDay()] + '）';
}

// ── 导出 ──────────────────────────────────────────────────────
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { sharePlan, calcEndTime, getTodayStr };
}