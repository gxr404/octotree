// When Github page loads at repo path e.g. https://github.com/jquery/jquery, the HTML tree has
// <main id="js-repo-pjax-container"> to contain server-rendered HTML in response of pjax.
// However, that <main> element doesn't have "id" attribute if the Github page loads at specific
// File e.g. https://github.com/jquery/jquery/blob/master/.editorconfig.
// Therefore, the below selector uses many path but only points to the same <main> element
const GH_PJAX_CONTAINER_SEL = '#page';
// const GH_PJAX_CONTAINER_SEL = '#js-repo-pjax-container, div[itemtype="http://schema.org/SoftwareSourceCode"] main, [data-pjax-container]';

const GH_CONTAINERS = '.container, .container-lg, .container-responsive';
const GH_MAX_HUGE_REPOS_SIZE = 50;
const GH_HIDDEN_RESPONSIVE_CLASS = '.d-none';
const GH_RESPONSIVE_BREAKPOINT = 1010;
const HOST = '//bitbucket.org'
const APIPREFIX = '/rest/api/latest'  // latest 可能为版本号
const MAXLIMIT = 99999 // bitbucket 的请求是以分页展示该标识设置请求每页的条数

// bitbucket 不支持pjax
class Bitbucket extends Adapter {
  constructor() {
    super();
  }

  // @override
  init($sidebar) {
    super.init($sidebar);

    // Fix #151 by detecting when page layout is updated.
    // In this case, split-diff page has a wider layout, so need to recompute margin.
    // Note that couldn't do this in response to URL change, since new DOM via pjax might not be ready.
    const diffModeObserver = new window.MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (~mutation.oldValue.indexOf('split-diff') || ~mutation.target.className.indexOf('split-diff')) {
          return $(document).trigger(EVENT.LAYOUT_CHANGE);
        }
      });
    });

    diffModeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['class'],
      attributeOldValue: true
    });
  }

  // @override
  getCssClass() {
    return 'octotree-github-sidebar';
  }

  // @override
  async shouldLoadEntireTree(repo) {
    const isLoadingPr = await extStore.get(STORE.PR) && repo.pullNumber;
    if (isLoadingPr) {
      return true;
    }

    const isGlobalLazyLoad = await extStore.get(STORE.LAZYLOAD);
    if (isGlobalLazyLoad) {
      return false;
    }

    // Else, return true only if it isn't in a huge repo list, which we must lazy load
    const key = `${repo.projectKey}/${repo.repositorySlug}`;
    const hugeRepos = await extStore.get(STORE.HUGE_REPOS);
    if (hugeRepos[key] && isValidTimeStamp(hugeRepos[key])) {
      // Update the last load time of the repo
      hugeRepos[key] = new Date().getTime();
      await extStore.set(STORE.HUGE_REPOS, hugeRepos);
    }
    return !hugeRepos[key];
  }

  // @override
  getCreateTokenUrl() {
    // github create token url 
    // return (
    //   `${location.protocol}//${location.host}/settings/tokens/new?` +
    //   'scopes=repo&description=Octotree%20browser%20extension'
    // );
    return ''
  }

  // @override
  updateLayout(sidebarPinned, sidebarVisible, sidebarWidth) {
    const SPACING = 20;
    const $containers =
      $('html').width() <= GH_RESPONSIVE_BREAKPOINT
        ? $(GH_CONTAINERS).not(GH_HIDDEN_RESPONSIVE_CLASS)
        : $(GH_CONTAINERS);

    const shouldPushEverything = sidebarPinned && sidebarVisible;

    if (shouldPushEverything) {
      $('html').css('margin-left', sidebarWidth);

      const autoMarginLeft = ($(document).width() - $containers.width()) / 2;
      const marginLeft = Math.max(SPACING, autoMarginLeft - sidebarWidth);
      $containers.each(function () {
        const $container = $(this);
        const paddingLeft = ($container.innerWidth() - $container.width()) / 2;
        $container.css('margin-left', marginLeft - paddingLeft);
      })
    } else {
      $('html').css('margin-left', '');
      $containers.css('margin-left', '');
    }
  }

  // @override
  async getRepoFromPath(currentRepo, token, cb) {
    if (!await octotree.shouldShowOctotree()) {
      return cb();
    }

    // projects/(projectKey)/repos/(repositorySlug)[/(type)][/(typeId)]
    const match = window.location.pathname.match(/\/projects\/([^\/]+)\/repos\/([^\/]+)(?:\/([^\/]+))?(?:\/([^\/]+))?/);

    const searchArr = encodeURIComponent(window.location.search).slice(1,).split('&')
    const queryParams = {}
    searchArr.forEach((val) => {
      const valArr = val.split('=')
      if (valArr.length === 2) {
        queryParams[valArr[0]] = valArr[1]
      }
    })

    const projectKey = match[1];
    const repositorySlug = match[2];
    const type = match[3];
    const typeId = match[4];

    const isPR = type === 'pull-requests' && typeId;

   // Not a repository, skip
    if (!projectKey || !repositorySlug) {
      return cb()
    }

    // Get branch by inspecting URL or DOM, quite fragile so provide multiple fallbacks.
    // TODO would be great if there's a more robust way to do this
    /**
     * Github renders the branch name in one of below structure depending on the length
     * of branch name. We're using this for default code page or tree/blob.
     *
     * Option 1: when the length is short enough
     * <summary title="Switch branches or tags">
     *   <span class="css-truncate-target">feature/1/2/3</span>
     * </summary>
     *
     * Option 2: when the length is too long
     * <summary title="feature/1/2/3/4/5/6/7/8">
     *   <span class="css-truncate-target">feature/1/2/3...</span>
     * </summary>
     */
    const branchDropdownMenuSummary = $('#repository-layout-revision-selector');
    const branchNameInTitle = branchDropdownMenuSummary.attr('title');
    const branchNameInSpan = branchDropdownMenuSummary.find('span.name').text();
    const branchFromSummary =
      branchNameInTitle && branchNameInTitle.toLowerCase().startsWith('switch branches')
        ? branchNameInSpan
        : branchNameInTitle;

    const branch =
      // Use the commit ID when showing a particular commit
      (type === 'commits' && typeId) ||
      // Use 'master' when viewing repo's releases or tags
      ((type === 'releases' || type === 'tags') && 'master') ||
      // Get commit ID or branch name from the DOM
      branchFromSummary ||
      // ($('.overall-summary .numbers-summary .commits a').attr('href') || '').replace(
      //   `/${username}/${reponame}/commits/`,
      //   ''
      // ) ||

      // 文件/ 目录
      // The above should work for tree|blob, but if DOM changes, fallback to use ID from URL
      // ((type === 'tree' || type === 'blob') && typeId) ||
      (
        type === 'browse'
        && /^refs\/heads\//.test(queryParams.at)
        && queryParams.at.replace(/^refs\/heads\/(.*)/, '$1')
      ) ||

      // pr 详情页
      // Use target branch in a PR page
      (isPR ? ($('.branch-from-to .ref-name-to').attr('original-title') || ':').match(/:(.*)/)[1] : null) ||

      // 采用上个分支
      // Reuse last selected branch if exist
      (currentRepo.projectKey === projectKey && currentRepo.repositorySlug === repositorySlug && currentRepo.branch) ||

      // Get default branch from cache
      this._defaultBranch[projectKey + '/' + repositorySlug];

    const showOnlyChangedInPR = await extStore.get(STORE.PR);
    const pullNumber = isPR && showOnlyChangedInPR ? typeId : null;
    const pullHead = isPR
      ? ($('.branch-from-to .ref-name-from').attr('original-title') || ':').match(/:(.*)/)[1] 
      : null;
    const displayBranch = isPR && pullHead ? `${branch} < ${pullHead}` : null;
    const repo = {projectKey, repositorySlug, branch, displayBranch, pullNumber};
    // const repo2 = {projectKey, repositorySlug}
    if (repo.branch) {
      cb(null, repo);
    } else {
      // Still no luck, get default branch for real
      this.getDefaultBranch({repo, token}, (err, data) => {
        if (err) return cb(err);
        repo.branch = this._defaultBranch[projectKey + '/' + repositorySlug] = data.displayId || 'master';
        cb(null, repo);
      });
    }
  }

  // @override
  loadCodeTree(opts, cb) {
    opts.encodedBranch = encodeURIComponent(decodeURIComponent(opts.repo.branch));

    opts.path = `?at=${(opts.node && (opts.node.sha || opts.encodedBranch)) || opts.encodedBranch}&limit=${MAXLIMIT}`
    this._loadCodeTreeInternal(opts, null, cb);
  }

  get isOnPRPage() {
    // projects/(projectKey)/repos/(repositorySlug)[/(type)][/(typeId)]
    const match = window.location.pathname.match(/\/projects\/([^\/]+)\/repos\/([^\/]+)(?:\/([^\/]+))?(?:\/([^\/]+))?/);
    const type = match[3];
    const typeId = match[4];
    return type === 'pull-requests' && typeId;
  }

  // @override
  _getTree(path, opts, cb) {
    if (opts.repo.pullNumber) {
      this._getPatch(opts, cb);
    } else {
      const protocol = location.protocol
      const urlPrefix = `${protocol}${HOST}${APIPREFIX}`
      const url = `${urlPrefix}/projects/${opts.repo.projectKey}/repos/${opts.repo.repositorySlug}/files${path}`

      this._get(url, opts, (err, res) => {
        if (err) cb(err);
        else cb(null, this.treeTransform(res.values, opts));
      });
    }
  }

  /**
   * Get files that were patched in Pull Request.
   * The diff map that is returned contains changed files, as well as the parents of the changed files.
   * This allows the tree to be filtered for only folders that contain files with diffs.
   * @param {Object} opts: {
   *                  path: the starting path to load the tree,
   *                  repo: the current repository,
   *                  node (optional): the selected node (null to load entire tree),
   *                  token (optional): the personal access token
   *                 }
   * @param {Function} cb(err: error, diffMap: Object)
   */
  _getPatch(opts, cb) {
    const {pullNumber, repositorySlug, projectKey} = opts.repo || {};
    const protocol = location.protocol
    const urlPrefix = `${protocol}${HOST}${APIPREFIX}`
    const url = `${urlPrefix}/projects/${projectKey}/repos/${repositorySlug}/pull-requests/${pullNumber}/changes?limit=${MAXLIMIT}`
    this._get(url, opts, (err, res) => {
      if (err) cb(err);
      else {
        const values = res.values || []
        const diffMap = {};

        values.forEach((file, index) => {
          if (!file) return
          diffMap[file.path.toString] = {
            type: 'blob',
            diffId: index,
            action: file.type,
            blob_url: file.blob_url,
            // 增加和减少的条数 bitbucket 无增加减少条数的数据
            // additions: file.additions,
            // deletions: file.deletions,
            filename: file.path.toString,
            // path: file.path.parent,
            sha: file.contentId
          };

          // Record ancestor folders
          const folderPath = file.path.toString
            .split('/')
            .slice(0, -1)
            .join('/');
          const split = folderPath.split('/');

          // Aggregate metadata for ancestor folders
          split.reduce((path, curr) => {
            if (path.length) {
              path = `${path}/${curr}`;
            } else {
              path = `${curr}`;
            }

            if (diffMap[path] == null) {
              diffMap[path] = {
                type: 'tree',
                filename: path,
                filesChanged: 1,
                // additions: file.additions,
                // deletions: file.deletions
              };
            } else {
              // diffMap[path].additions += file.additions;
              // diffMap[path].deletions += file.deletions;
              diffMap[path].filesChanged++;
            }
            return path;
          }, '');
        });

        // Transform to emulate response from get `tree`
        const tree = Object.keys(diffMap).map((fileName) => {
          // TODO
          const patch = diffMap[fileName];
          return {
            patch,
            path: fileName,
            sha: patch.sha,
            type: patch.type,
            url: patch.blob_url
          };
        });

        // Sort by path, needs to be alphabetical order (so parent folders come before children)
        // Note: this is still part of the above transform to mimic the behavior of get tree
        tree.sort((a, b) => a.path.localeCompare(b.path));
        cb(null, tree);
      }
    });
  }

  // @override 子git TODO
  _getSubmodules(tree, opts, cb) {
    const item = tree.filter((item) => /^\.gitmodules$/i.test(item.path))[0];
    if (!item) return cb();
    const {repositorySlug, projectKey} = opts.repo || {};
    const protocol = location.protocol
    const urlPrefix = `${protocol}${HOST}${APIPREFIX}`
    const url = `${urlPrefix}/projects/${projectKey}/repos/${repositorySlug}/browse/${item.path}${opts.path}`
    this._get(url, opts, (err, res) => {
      if (err) return cb(err);
      const data = res.lines.map((item) => item.text).join('\n')
      cb(null, parseGitmodules(data));
    });
  }

  _get(path, opts, cb) {
    let url;

    if (path && path.startsWith('http')) {
      url = path;
    }

    const cfg = {url, method: 'GET', cache: false};

    if (opts.token) {
      cfg.headers = {Authorization: 'token ' + opts.token};
    }

    $.ajax(cfg)
      .done((data, textStatus, jqXHR) => {
        cb(null, data, jqXHR);
      })
      .fail((jqXHR) => this._handleError(cfg, jqXHR, cb));
  }

  getDefaultBranch(opts, cb) {
    const {repositorySlug, projectKey} = opts.repo || {};
    const protocol = location.protocol
    const urlPrefix = `${protocol}${HOST}${APIPREFIX}`
    const url = `${urlPrefix}/projects/${projectKey}/repos/${repositorySlug}/branches?limit=${MAXLIMIT}`
    this._get(url, opts, (err, data) => {
      if (err) return cb(err)
      if(Array.isArray(data.values)) {
        return cb(null, data.values.find((item) => item.isDefault))
      }
      cb(null, {})
    })
  }

  treeTransform(filesArr, opts) {
    const dirArr = []
    const tree = []
    filesArr.forEach((item) => {
      if (/\//.test(item)) {
        const arr = item.split('/')
        arr.forEach((item, index) => {
          if (index === arr.length-1) return
          const dir = arr.slice(0, index+1).join('/')
          if (!dirArr.includes(dir)){
            dirArr.push(dir)
            tree.push({
              path: dir,
              type: 'tree',
            })
          }
        })
      }
      tree.push({
        path: item,
        type: 'blob',
      })
    })
    return tree
  }

  /**
   * Returns item's href value.
   * @api protected
   */
  _getItemHref(repo, type, encodedPath, encodedBranch) { 
    return `/projects/${repo.projectKey}/repos/${repo.repositorySlug}/browse/${encodedPath}?at=${encodedBranch}`;
  }

  /**
   * Returns patch's href value.
   * @api protected
   */
  _getPatchHref(repo, patch) {
    return `/projects/${repo.projectKey}/repos/${repo.repositorySlug}/pull-requests/${repo.pullNumber}/diff#${patch.filename}`;
  }
}
