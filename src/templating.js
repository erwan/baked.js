var Q = require("q");
var fs = require("fs");
var vm = require("vm");
var ejs = require("ejs");
var consolidate = require("consolidate");

(function (exporter, undefined) {
  "use strict";

  // Legacy templating for .html files: ejs with [% %] separators
  function legacyRendering(content, ctx) {
    ejs.open = '[%';
    ejs.close = '%]';
    return ejs.render(content, ctx);
  }

  function renderTemplate(path, ctx, conf) {
    // The vm context sandbox is kept separate from the template context to work around an issue
    // in earlier versions of node (pre v0.11.7) where escape() is added to the template context.
    if (!ctx._sandbox) {
      ctx._sandbox = vm.createContext(ctx);
    }
    ctx._sandbox.__render__ = function render() {
      delete ctx._sandbox.__render__;
      var resultP;
      var parts = path.split(".");
      var ext = parts[parts.length - 1];
      if (ext == 'html' || ext == 'xml') {
        resultP = Q
          .ninvoke(fs, 'readFile', path, "utf8")
          .then(function (content) {
            return legacyRendering(content, ctx);
          });
      } else {
        var engine = consolidate[ext];
        if (!engine) {
          if (conf && conf.logger) {
            conf.logger.error("Unknown template engine: " + ext);
          } else {
            console.log("Unknown template engine: " + ext);
          }
        }
        resultP = engine(path, ctx);
      }
      return resultP.then(function(html) {
        var scriptRx = /<script\s+type="text\/prismic-query"([^>]*)>([\s\S]*?)<\/script>/ig;
        return html.replace(scriptRx, "");
      });
    };

    return vm.runInContext("__render__()", ctx._sandbox);
  }

  exporter.legacy = legacyRendering;
  exporter.render = renderTemplate;

}(typeof exports === 'object' && exports ? exports : (typeof module === "object" && module && typeof module.exports === "object" ? module.exports : window)));
