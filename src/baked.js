var _ = require("lodash");
var Promise = require("bluebird");
var Prismic = require("prismic.io").Prismic;
var Q = require("q");
var vm = require("vm");
var templating = require("./templating");

(function (exporter, undefined) {
  "use strict";

  function getAPI(conf) {
    var deferred = Q.defer();
    Prismic.Api(conf.api, function(err, api) {
      if (err) {
        err.url = conf.api;
        deferred.reject(err);
      }
      else deferred.resolve(api);
    }, conf.accessToken, conf.requestHandler);
    return deferred.promise;
  }

  var DEFAULT_HELPERS = {
    _: _,
    only: function(test) {
      if (test) {
        return function (block) { block(); };
      } else {
        return function (block) {};
      }
    }
  };

  function defaultHelpers(conf) {
    return _.assign({}, DEFAULT_HELPERS, {
      onlyBrowser: DEFAULT_HELPERS.only(conf.mode == 'browser'),
      onlyServer: DEFAULT_HELPERS.only(conf.mode == 'server')
    });
  }

  // Code from Consolidate.js to customize EJS templating (custom open/close for backward compat)

  function promisify(fn, exec) {
    return new Promise(function (res, rej) {
      fn = fn || function (err, html) {
        if (err) {
          return rej(err);
        }
        res(html);
      };
      exec(fn);
    });
  }


  function requireFile(content, ctx, filename) {
    return vm.runInContext(content, ctx._sandbox, filename);
  }

  function renderQuery(query, env, api) {
    env = env || {};
    var rxVar = /(^|[^$])\$(([a-z][a-z0-9]*)|\{([a-z][a-z0-9]*)\})/ig;
    var rxBookmark = /(^|[^$])\$\{bookmarks(\.([-_a-zA-Z0-9]+)|\[(['"])([-_a-zA-Z0-9]+)\4\])\}/ig;
    return query
      .replace(rxVar, function (str, prev, _, simple, complex) {
        return prev + (env[simple || complex] || '');
      })
      .replace(rxBookmark, function (str, prev, _1, bookmarkDot, _2, bookmarkBraket) {
        return prev + (api.bookmarks[bookmarkDot || bookmarkBraket] || '');
      })
      .replace(/\$\$/g, '$');
  }

  function renderRoute(route, env) {
    var rx = /\$(([a-z][a-z0-9]*)|\{([a-z][a-z0-9]*)\})/ig;
    return route.replace(rx, function (str, simple, complex) {
      var variable = simple || complex;
      return env && env[variable] || '';
    });
  }

  // Extract bindings from str, return an array of the form:
  // [{
  //   attributes: {},
  //   content: "[[(:d = at(document.type, "article"))]]"
  // }, {
  //   ..
  // }]
  function findBindings(str, args, isJade) {
    function toUpperCase(str, l) { return l.toUpperCase(); }
    // Because Jade is about indentation, we need a line-by-line parser
    // instead of the regexp parser
    var scriptRx;
    var match;
    var bindings = [];
    if (isJade) {
      scriptRx = /script\(type='text\/prismic-query'([^\)]*)\)\./i;
      var lines = str.split('\n');
      var currentBinding = null;
      _.forEach(lines, function(line) {
        if ((match = scriptRx.exec(line)) !== null) {
          // New script line
          currentBinding = {
            indent: line.indexOf('script'),
            attributes: _.reduce(match[1].split(","), function(acc, attr) {
              var splitted = attr.split('=');
              if (splitted.length === 2) {
                acc[splitted[0].trim().replace(/^data-/, '')] = splitted[1].trim().slice(1, -1);
              }
              return acc;
            }, {}),
            content: ""
          };
        } else if (currentBinding && line.match(/^\s*/)[0].length > currentBinding.indent) {
          currentBinding.content = currentBinding.content + line;
        } else if (currentBinding) {
          bindings.push(currentBinding);
          currentBinding = null;
        }
      });
    } else {
      scriptRx = /<script +type="text\/prismic-query"([^>]*)>([\s\S]*?)<\/script>/ig;
      str.replace(scriptRx, function (str, scriptParams, scriptContent) {
        var dataRx = /data-([a-z0-9\-]+)=("[^"]*"|'[^']*')/ig;
        var attributes = {};
        while ((match = dataRx.exec(scriptParams)) !== null) {
          var attribute = match[1].toLowerCase();
          var value = match[2].slice(1, -1); // Remove quotes or double quotes
          var key;
          attributes[attribute] = value;
        }
        bindings.push({
          attributes: attributes,
          content: scriptContent
        });
        return str;
      });
    }

    return _.reduce(bindings, function(acc, binding) {
      var params = {};
      var dataset = {};

      _.forEach(binding.attributes, function(value, attribute) {
        var key;
        if (/^query-/.test(attribute)) {
          key = attribute.replace(/^query-/, '').replace(/-(.)/g, toUpperCase);
          params[key] = value;
        } else {
          key = attribute.replace(/-(.)/g, toUpperCase);
          dataset[key] = value;
        }
      });
      var name = dataset.binding;
      if (name) {
        _.assign(binding, {
          form: dataset.form || 'everything',
          dataset: dataset,
          render: function(api) {
            return renderQuery(binding.content, args, api);
          }
        });
        acc[name] = binding;
      }
      return acc;
    }, {});
  }

  function initConf(opts) {
    var conf = {
      mode: opts.mode,
      env: opts.env || {},
      helpers: opts.helpers || {},
      logger: opts.logger,
      args: opts.args || {},
      ref: opts.ref,
      accessToken: opts.accessToken,
      api: opts.api,
      tmpl: opts.tmpl,
      src: opts.src,
      setContext: opts.setContext || _.noop,
      requestHandler: opts.requestHandler
    };

    if (opts.engine && !conf.engine) {
      conf.logger.error("Unknown template engine: " + opts.engine);
      return;
    }

    // The Prismic.io API endpoint
    if (!conf.api) {
      conf.logger.error(
        'Please define your api endpoint in the <head> element. ' +
        'For example: ' +
        '<meta name="prismic-api" content="https://lesbonneschoses.prismic.io/api">');
      return;
    }

    conf.bindings = findBindings(conf.tmpl, conf.args, conf.src.endsWith('.jade'));

    return conf;
  }

  function initRender(router, opts) {
    if (!opts) { opts = {}; }
    var conf = opts.conf || initConf(opts);
    return render(router, conf);
  }

  var render = function(router, conf) {
    return getAPI(conf).then(function(api) {
      return Q
        .all(_.map(conf.bindings, function(binding, name) {
          var deferred = Q.defer();
          var form = api.form(binding.form);
          form = form.ref(conf.ref || api.master());
          form = _.reduce(binding.params, function (form, value, key) {
            return form.set(key, renderQuery(value, conf.args, api));
          }, form);
          form
            .query(binding.render(api))
            .submit(function (err, documents) {
              // skip the NodeJS specific 3rd argument (readableState...)
              if (err) { deferred.reject(err); }
              else {
                if (binding.dataset.eager) {
                  var promises = _.map(documents.results, function(doc, index) {
                    var relationshipDeferred = Q.defer();
                    var ids = _.map(doc.linkedDocuments(), 'id');

                    if (_.isEmpty(ids.length)) {
                      var query = '[[:d = any(document.id, ["' + ids.join('","') + '"]) ]]';
                      api.form("everything")
                        .ref(conf.ref || api.master())
                        .query(query)
                        .submit(function(err, relatedResults) {
                          if (err) { relationshipDeferred.reject(err); }
                          else {
                            var keys = _.map(relatedResults.results, 'id');
                            var related = _.zipObject(keys, relatedResults.results);
                            documents.results[index].loadedDocuments = related;
                            relationshipDeferred.resolve();
                          }
                        });
                    } else {
                      relationshipDeferred.resolve();
                    }

                    return relationshipDeferred.promise;
                  });
                  Q.all(promises).then(
                    function() { deferred.resolve(documents); },
                    function(err) { deferred.reject(err); }
                  );
                } else {
                  deferred.resolve(documents);
                }
              }
            });
          return deferred.promise
            .then(
              function (documents) { return [name, documents]; },
              function (err) { conf.logger.error("Error while running query: \n%s\n", binding.predicates, err); }
            );
        }))
        .then(function (results) {
          var env = _.assign({}, {
            mode: conf.mode,
            api: api,
            bookmarks: api.bookmarks,
            types: api.types,
            refs: api.data.refs,
            tags: api.data.tags,
            master: api.master(),
            ref: conf.ref
          }, conf.env);
          return _.reduce(results, function (documentSets, res) {
            if(res) {
              documentSets[res[0]] = res[1];
            }
            return documentSets;
          }, env);
        }).then(function(documentSets) {
          documentSets.loggedIn = !!conf.accessToken;

          _.extend(documentSets, defaultHelpers(conf));
          if (conf.helpers) { _.extend(documentSets, conf.helpers); }
          _.extend(documentSets, conf.args);

          conf.setContext(documentSets);
          return templating.render(conf.src, documentSets, conf);
        }).then(function(html) {
          var result = html.replace(/(<img[^>]*)data-src="([^"]*)"/ig, '$1src="$2"');
          return {api: api, content: result};
        });

    });

  };

  function parseRoutingInfos(content, ctx) {
    var rxAPI = /<meta +name="prismic-api" +content="([^"]+)" *>/ig;
    var rxParam = /<meta +name="prismic-routing-param" +content="([a-z][a-z0-9]*)" *>/ig;
    var rxPattern = /<meta +name="prismic-routing-pattern" +content="([\/$a-z][\/${}a-z0-9._-]*)" *>/ig;
    var rxURLBase = /<meta +name="prismic-url-base" +content="([^"]+)" *>/ig;
    var match;
    var res = {
      api: ctx.api,
      url: ctx.urlBase,
      params: []
    };
    if ((match = rxAPI.exec(content)) !== null) {
      res.api = match[1];
    }
    if (!res.api) { return null; }  // no api == no template
    while ((match = rxParam.exec(content)) !== null) {
      res.params.push(match[1]);
    }
    if ((match = rxPattern.exec(content)) !== null) {
      res.route = match[1];
    }
    if ((match = rxURLBase.exec(content)) !== null) {
      res.url = match[1];
    }
    return res;
  }

  exporter.render = initRender;
  exporter.initConf = initConf;
  exporter.parseRoutingInfos = parseRoutingInfos;
  exporter.renderRoute = renderRoute;
  exporter.requireFile = requireFile;

}(typeof exports === 'object' && exports ? exports : (typeof module === "object" && module && typeof module.exports === "object" ? module.exports : window)));
