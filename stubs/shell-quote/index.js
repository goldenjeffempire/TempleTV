'use strict';

// Minimal faithful implementation of shell-quote@1.8.3.
// Used as a pnpm.overrides stub so Expo web builds succeed in environments
// where the npm registry copy is blocked (e.g. Replit package firewall).
// react-devtools-core lists shell-quote as a dependency of react-native but
// the code path that calls it is never exercised during `expo export --platform web`.

var CONTROL = '(?:' + [
  '\\|\\|', '\\&\\&', ';;', '\\|\\&', '\\<\\(', '>>', '>\\&',
  '[&;()|<>]'
].join('|') + ')';

var META = '|&;()<> \t';
var BAREWORD = '(?:[^\\|\\&;()<> \\\\\t\'"\\|]+)';
var SINGLE_QUOTE = "'([^']+|[^']*$)'?";
var DOUBLE_QUOTE = '"((?:[^"\\\\]|\\\\.)*)"' + '|"([^"]*$)"';

exports.quote = function (xs) {
  return xs.map(function (s) {
    if (s && typeof s === 'object') {
      return s.op.replace(/(.)/g, '\\$1');
    }
    if (s === '') return "''";
    var str = String(s);
    if (/["\s]/.test(str) && !/'/  .test(str)) {
      return '"' + str
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\$/g, '\\$')
        .replace(/`/g, '\\`') + '"';
    }
    if (/["'\s]/.test(str)) {
      return "'" + str.replace(/'/g, "'\\''") + "'";
    }
    return str.replace(/([#!"$&'()*,:;<=>?@[\\\]^`{|}~\s])/g, '\\$1');
  }).join(' ');
};

exports.parse = function (s, env, opts) {
  if (!s || !s.trim()) return [];
  opts = opts || {};

  var chunker = new RegExp([
    '(' + CONTROL + ')',
    '(' + BAREWORD + '|' + SINGLE_QUOTE + '|' + DOUBLE_QUOTE + ')*'
  ].join('|'), 'g');

  var match = s.match(chunker);
  if (!match) return [];
  if (typeof env !== 'function') {
    var envObj = env || {};
    env = function (key) { return envObj[key]; };
  }

  return match.filter(Boolean).reduce(function (sum, token) {
    var m;

    // control operator
    m = token.match(new RegExp('^' + CONTROL + '$'));
    if (m) return sum.concat({ op: token });

    // environment variable substitution
    token = token.replace(/\$([a-zA-Z_][a-zA-Z0-9_]*|\{[^}]+\})/g, function (_, k) {
      var key = k.replace(/^\{|\}$/g, '');
      var val = env(key);
      return val === undefined ? '' : val;
    });

    // single-quoted segment
    token = token.replace(new RegExp(SINGLE_QUOTE, 'g'), function (_, q) {
      return q === undefined ? '' : q;
    });

    // double-quoted segment  
    token = token.replace(new RegExp(DOUBLE_QUOTE, 'g'), function (_, q1, q2) {
      var q = q1 !== undefined ? q1 : (q2 !== undefined ? q2 : '');
      return q.replace(/\\([\s\S])/g, '$1');
    });

    return sum.concat(token || []);
  }, []);
};
