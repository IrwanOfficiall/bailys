const crypto = require('crypto');

function extractHyperlink(text) {
  let hyperlink = [],
    stack = [],
    result = '',
    last = 0,
    index = 1,
    entity = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] == '[' && text[i - 1] != '\\') {
      stack.push(i);
    } else if (text[i] == ']' && text[i + 1] == '(') {
      let start = stack.pop();
      if (start == null) continue;
      let end = i + 2,
        depth = 1;
      while (end < text.length && depth) {
        if (text[end] == '(' && text[end - 1] != '\\') depth++;
        else if (text[end] == ')' && text[end - 1] != '\\') depth--;
        end++;
      }
      if (depth) continue;
      let txt = text.slice(start + 1, i).trim(),
        url = text.slice(i + 2, end - 1),
        reference_id = txt ? 0 : index++,
        key = `IE_${entity++}`,
        tag = `{{${key}}}${txt || 'Nixel'}{{/${key}}}`;
      result += text.slice(last, start) + tag;
      last = end;
      hyperlink.push({ reference_id, key, text: txt, url });
      i = end - 1;
    }
  }
  result += text.slice(last);
  return { text: result, hyperlink };
}

const tokenizer = (code, lang = 'javascript') => {
  const keywordsMap = {
    javascript: new Set([
      'break','case','catch','continue','debugger','delete','do','else','finally','for','function','if','in','instanceof','new','return','switch','this','throw','try','typeof','var','void','while','with','true','false','null','undefined','class','const','let','super','extends','export','import','yield','static','constructor','async','await','get','set'
    ])
  };
  const TYPE_MAP = { 0:'DEFAULT', 1:'KEYWORD', 2:'METHOD', 3:'STR', 4:'NUMBER', 5:'COMMENT' };
  const keywords = keywordsMap[lang] || new Set();
  const tokens = [];
  let i = 0;
  const push = (content, type) => {
    if (!content) return;
    const last = tokens[tokens.length - 1];
    if (last && last.highlightType === type) last.codeContent += content;
    else tokens.push({ codeContent: content, highlightType: type });
  };
  while (i < code.length) {
    const c = code[i];
    if (/\s/.test(c)) {
      let s = i;
      while (i < code.length && /\s/.test(code[i])) i++;
      push(code.slice(s, i), 0);
      continue;
    }
    if (c === '/' && code[i + 1] === '/') {
      let s = i;
      i += 2;
      while (i < code.length && code[i] !== '\n') i++;
      push(code.slice(s, i), 5);
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let s = i;
      const q = c;
      i++;
      while (i < code.length) {
        if (code[i] === '\\' && i + 1 < code.length) i += 2;
        else if (code[i] === q) { i++; break; }
        else i++;
      }
      push(code.slice(s, i), 3);
      continue;
    }
    if (/[0-9]/.test(c)) {
      let s = i;
      while (i < code.length && /[0-9.]/.test(code[i])) i++;
      push(code.slice(s, i), 4);
      continue;
    }
    if (/[a-zA-Z_$]/.test(c)) {
      let s = i;
      while (i < code.length && /[a-zA-Z0-9_$]/.test(code[i])) i++;
      const word = code.slice(s, i);
      let type = 0;
      if (keywords.has(word)) type = 1;
      else {
        let j = i;
        while (j < code.length && /\s/.test(code[j])) j++;
        if (code[j] === '(') type = 2;
      }
      push(word, type);
      continue;
    }
    push(c, 0);
    i++;
  }
  return {
    codeBlock: tokens,
    unified_codeBlock: tokens.map(t => ({ content: t.codeContent, type: TYPE_MAP[t.highlightType] }))
  };
};

const toTableMetadata = (arr) => {
  if (!Array.isArray(arr) || arr.length < 2) throw new Error('Format tabel ngawur');
  const [header, ...rows] = arr;
  const maxLen = Math.max(header.length, ...rows.map(r => r.length));
  const normalize = (r) => [...r, ...Array(maxLen - r.length).fill('')];
  const unified_rows = [
    { is_header: true, cells: normalize(header) },
    ...rows.map(r => ({ is_header: false, cells: normalize(r) }))
  ];
  const rowsMeta = unified_rows.map(r => ({
    items: r.cells,
    ...(r.is_header ? { isHeading: true } : {})
  }));
  return { title: '', rows: rowsMeta, unified_rows };
};

const sendRichMessage = async (conn, jid, richMessage, options = {}) => {
  const submessages = [];
  const sections = [];
  const richResponseSources = [];

  if (richMessage.text) {
    const parsed = typeof richMessage.text === 'string' ? extractHyperlink(richMessage.text) : richMessage.text;
    const text = parsed.text || parsed;
    const inline_entities = parsed.hyperlink ? parsed.hyperlink.map(({ reference_id, key, text, url }) => ({
      key,
      metadata: text?.trim()
        ? { display_name: text, is_trusted: true, url, __typename: 'GenAIInlineLinkItem' }
        : { reference_id, reference_url: url, reference_title: url, reference_display_name: url, sources: [], __typename: 'GenAISearchCitationItem' }
    })) : [];
    submessages.push({ messageType: 2, messageText: text });
    sections.push({
      view_model: {
        primitive: {
          text,
          inline_entities,
          __typename: 'GenAIMarkdownTextUXPrimitive'
        },
        __typename: 'GenAISingleLayoutViewModel'
      }
    });
  }

  if (richMessage.code) {
    const { language, code } = richMessage.code;
    const tokenized = tokenizer(code, language);
    submessages.push({
      messageType: 5,
      codeMetadata: { codeLanguage: language, codeBlocks: tokenized.codeBlock }
    });
    sections.push({
      view_model: {
        primitive: {
          language,
          code_blocks: tokenized.unified_codeBlock,
          __typename: 'GenAICodeUXPrimitive'
        },
        __typename: 'GenAISingleLayoutViewModel'
      }
    });
  }

  if (richMessage.table) {
    const tableData = richMessage.table;
    const meta = toTableMetadata(tableData);
    submessages.push({
      messageType: 4,
      tableMetadata: { title: '', rows: meta.rows }
    });
    sections.push({
      view_model: {
        primitive: {
          rows: meta.unified_rows,
          __typename: 'GenATableUXPrimitive'
        },
        __typename: 'GenAISingleLayoutViewModel'
      }
    });
  }

  if (richMessage.images) {
    const imageUrls = Array.isArray(richMessage.images) ? richMessage.images : [richMessage.images];
    submessages.push({
      messageType: 1,
      gridImageMetadata: {
        gridImageUrl: { imagePreviewUrl: imageUrls[0] },
        imageUrls: imageUrls.map(url => ({
          imagePreviewUrl: url,
          imageHighResUrl: url,
          sourceUrl: 'https://google.com'
        }))
      }
    });
    imageUrls.forEach(url => {
      sections.push({
        view_model: {
          primitive: {
            media: { url, mime_type: 'image/jpeg' },
            imagine_type: 3,
            status: { status: 'READY' },
            __typename: 'GenAIImaginePrimitive'
          },
          __typename: 'GenAISingleLayoutViewModel'
        }
      });
    });
  }

  if (richMessage.reels) {
    const reelsItems = Array.isArray(richMessage.reels) ? richMessage.reels : [richMessage.reels];
    submessages.push({
      messageType: 9,
      contentItemsMetadata: {
        contentType: 1,
        itemsMetadata: reelsItems.map(item => ({
          reelItem: {
            title: item.title,
            profileIconUrl: item.profileIconUrl,
            thumbnailUrl: item.thumbnailUrl,
            videoUrl: item.videoUrl
          }
        }))
      }
    });
    sections.push({
      view_model: {
        primitives: reelsItems.map(item => ({
          reels_url: item.videoUrl,
          thumbnail_url: item.thumbnailUrl,
          creator: item.title,
          avatar_url: item.profileIconUrl,
          reels_title: item.reels_title || '',
          likes_count: item.likes_count || 0,
          shares_count: item.shares_count || 0,
          view_count: item.view_count || 0,
          reel_source: item.reel_source || 'IG',
          is_verified: item.is_verified || false,
          __typename: 'GenAIReelPrimitive'
        })),
        __typename: 'GenAIHScrollLayoutViewModel'
      }
    });
    reelsItems.forEach((item, idx) => {
      richResponseSources.push({
        provider: 'UNKNOWN',
        thumbnailCDNURL: item.thumbnailUrl,
        sourceProviderURL: item.videoUrl,
        sourceQuery: '',
        faviconCDNURL: item.profileIconUrl,
        citationNumber: idx + 1,
        sourceTitle: item.title
      });
    });
  }

  if (richMessage.sources) {
    const sourceArr = Array.isArray(richMessage.sources) ? richMessage.sources : [richMessage.sources];
    sections.push({
      view_model: {
        primitive: {
          sources: sourceArr.map(s => typeof s === 'object' ? s : {
            source_type: 'THIRD_PARTY',
            source_display_name: s[2] || '',
            source_subtitle: 'AI',
            source_url: s[1] || '',
            favicon: { url: s[0] || '', mime_type: 'image/jpeg', width: 16, height: 16 }
          }),
          __typename: 'GenAISearchResultPrimitive'
        },
        __typename: 'GenAISingleLayoutViewModel'
      }
    });
  }

  const unifiedData = {
    response_id: crypto.randomUUID(),
    sections
  };

  const payload = {
    messageContextInfo: {
      deviceListMetadata: {},
      deviceListMetadataVersion: 2,
      botMetadata: {
        messageDisclaimerText: richMessage.title || '',
        richResponseSourcesMetadata: { sources: richResponseSources }
      }
    },
    botForwardedMessage: {
      message: {
        richResponseMessage: {
          messageType: 1,
          submessages,
          unifiedResponse: {
            data: Buffer.from(JSON.stringify(unifiedData)).toString('base64')
          },
          contextInfo: {
            forwardingScore: 1,
            isForwarded: true,
            forwardedAiBotMessageInfo: { botJid: '0@bot' },
            forwardOrigin: 4
          }
        }
      }
    }
  };

  await conn.relayMessage(jid, payload, { messageId: `RICH_${Date.now()}`, ...options });
};

module.exports = { sendRichMessage, extractHyperlink, tokenizer, toTableMetadata };
