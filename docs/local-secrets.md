# TypeSafe 키 설정

`shadow`·`auto`·`evaluate` 및 Claude 함수 훅의 Jev 호출에는 TypeSafe API 키가 필요하다. 기본 방법은 `.env` 파일이다. Codex CLI는 Node.js 22 이상의 `node --env-file=.env`로, Claude 함수 훅은 파일을 직접 읽는 방식으로 사용한다. macOS, Linux, Windows에서 같은 키 파일 형식을 쓸 수 있다. 키체인을 선호한다면 아래의 macOS 전용 방법을 선택할 수 있다. `pass`·`force`와 키를 쓰지 않는 테스트에는 키가 필요 없다.

## 모든 OS: `.env` 파일

저장소 루트의 `.env.example`을 `.env`로 복사한다. macOS·Linux에서는 `cp .env.example .env`, Windows PowerShell에서는 `Copy-Item .env.example .env`를 사용한다. 텍스트 편집기로 `.env`의 `TYPESAFE_API_KEY=` 뒤에 실제 키를 입력한다. 키를 셸 명령 인자, 채팅 또는 이슈에 붙여넣지 않는다.

```dotenv
TYPESAFE_API_KEY=your-key-here
```

`.env`와 `.env.*`는 Git에서 무시하고 `.env.example`만 추적한다. `.env`는 **암호화되지 않은 로컬 파일**이므로 개인 계정만 접근할 수 있는 곳에 두고 클라우드 공유 폴더에 복사하지 않는다. macOS·Linux에서는 `chmod 600 .env`로 읽기 권한을 제한할 수 있다. 키를 더 보호해야 한다면 운영체제의 비밀 저장소를 사용한다.

저장소 루트에서 아래 명령으로 값 자체를 출력하지 않고 파일 로딩만 확인할 수 있다. 이 명령은 TypeSafe API를 호출하지 않는다.

```bash
node --env-file=.env -e "console.log(process.env.TYPESAFE_API_KEY ? 'TypeSafe key ready' : 'Key missing')"
```

실행할 때 `node --env-file=.env`를 기존 `node` 명령 앞부분에 넣는다. 파일이 없으면 Node가 오류를 내므로 키가 없는 상태를 조용히 지나치지 않는다. 이미 프로세스 환경에 같은 변수가 설정돼 있다면 빈 문자열이어도 그 값이 `.env` 값보다 우선한다. 위 확인 명령에서 `Key missing`이 나오면 기존 `TYPESAFE_API_KEY` 환경 변수도 확인한다([Node.js CLI 문서](https://nodejs.org/docs/latest-v22.x/api/cli.html#--env-fileconfig)).

```bash
node --env-file=.env dist/cli.js codex --mode shadow --metrics .local/codex.jsonl -- exec "다음 문장의 맞춤법만 고쳐줘: 좋내요."
```

`.env` 파일 대신 셸이나 CI의 비밀 관리 기능으로 `TYPESAFE_API_KEY`를 프로세스 환경에 넣어도 된다. 이 경우 `--env-file`을 생략한다. 라우터는 기존 호환 변수 `JEV_API_KEY`도 읽는다. Codex CLI 자식 프로세스에는 두 변수를 전달하지 않는다.

Claude 함수 훅 플러그인은 먼저 Claude 프로세스의 `TYPESAFE_API_KEY`를 확인하고, 없으면 `AMR_ENV_FILE`이 가리키는 `.env`를 읽는다. `AMR_ENV_FILE`도 없을 때는 저장소에서 직접 실행한 플러그인 기준으로 상위 디렉터리의 `.env`를 읽는다. 데스크톱 Code 탭처럼 플러그인을 사용자 skills 디렉터리에 설치한 경우에는 `AMR_ENV_FILE`에 절대 경로를 설정한다. 이 경로만 Claude 설정에 저장하면 키 값을 설정 파일에 적거나 Claude 인증 환경 변수로 넘길 필요가 없다. `.env`에는 `TYPESAFE_API_KEY=...` 한 줄을 사용한다.

## 선택 사항: macOS 로그인 키체인

macOS에서 디스크에 평문 `.env`를 두고 싶지 않을 때만 이 방식을 사용한다. `--keychain-service`와 `--keychain-account`를 함께 지정하면 라우터가 로그인 키체인에서 키를 직접 읽는다.

1. Spotlight(`Command`+`Space`)에서 **키체인 접근**을 열고 왼쪽에서 **로그인** 키체인을 선택한다.
2. `Command`+`N`으로 새 암호 항목을 만든다. 메뉴를 사용한다면 **파일 > 새로운 암호 항목**을 선택한다.
3. 아래 값을 입력하고 **추가**를 누른다. 암호 값은 키체인 UI에서 직접 입력한다.

- 항목 이름: `agent-model-router-typesafe`
- 계정: 현재 macOS 계정 이름(`id -un` 결과)
- 암호: TypeSafe API 키

키 값은 채팅, 이슈 또는 커밋에 올리지 않는다. [Apple 키체인 접근 단축키 안내](https://support.apple.com/guide/keychain-access/keyboard-shortcuts-kyca699a9058/mac)는 새 암호 항목의 `Command`+`N`을 안내한다.

### 이미 iCloud 키체인에 저장했다면

아래 `security find-generic-password` 절차는 **로그인** 키체인의 파일 기반 항목을 읽는다. iCloud 키체인의 항목은 별도의 데이터 보호 키체인에 있으므로 이 명령으로는 찾지 못할 수 있다([Apple 기술 문서](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains)). iCloud 항목은 그대로 두고, 같은 키를 **로그인** 키체인에 추가한다. 키체인 접근에서 로그인 키체인을 선택한 뒤 위 순서대로 만들거나, 본인 터미널에서 아래 명령을 실행한다.

```bash
security add-generic-password -a "$(id -un)" -s agent-model-router-typesafe \
  "$HOME/Library/Keychains/login.keychain-db" -w
```

`-w`가 마지막 인자이므로 터미널이 암호 입력을 요청한다. iCloud 항목에서 복사한 키를 그 입력창에 직접 붙여넣는다. 입력은 화면에 표시되지 않고 명령줄이나 셸 기록에도 들어가지 않는다. 키 값을 명령에 덧붙이지 않는다. 이 추가 항목은 로컬 로그인 키체인에 저장되며 iCloud 항목은 유지된다. 저장 뒤에는 다음 명령으로 값 조회 없이 존재만 확인할 수 있다.

```bash
security find-generic-password -a "$(id -un)" -s agent-model-router-typesafe \
  "$HOME/Library/Keychains/login.keychain-db" >/dev/null
```

아래 코드는 로컬 터미널에서 직접 실행하는 준비 확인용이다. 키 값을 출력하거나 API를 호출하지 않는다. 키체인 접근 권한 확인 창이 뜰 수 있다.

```bash
(
  set +x
  unset TYPESAFE_API_KEY JEV_API_KEY
  if ! TYPESAFE_API_KEY="$(/usr/bin/security find-generic-password \
    -s agent-model-router-typesafe -a "$(id -un)" -w)"; then
    exit 1
  fi
  [ -n "$TYPESAFE_API_KEY" ] || exit 1
  export TYPESAFE_API_KEY
  node -e 'process.stdout.write("TypeSafe key is ready (value hidden); no API call made.\n")'
)
```

키는 괄호 안의 셸과 자식 프로세스에만 전달되고 블록이 끝나면 셸 환경에서 사라진다. Codex/Claude 앱의 전역 설정이나 로그인 셸 설정은 바뀌지 않는다. 키체인 항목은 이후 사용을 위해 로컬에 남는다.

전송할 프롬프트와 유료 호출 범위를 확인한 뒤에는 위 셸 블록 대신 `evaluate`·`shadow` 명령에 `--keychain-service agent-model-router-typesafe --keychain-account "$(id -un)"`를 지정할 수 있다. 라우터가 키를 메모리에서만 사용하고 Codex CLI 자식 환경에는 전달하지 않는다. 한 터미널에서 설정한 환경 변수는 다른 터미널이나 앱 프로세스에 자동으로 전달되지 않는다. 키 값은 출력하거나 공유하지 않는다.

기존 비밀 관리 도구를 사용하는 경우에도 해당 도구의 프로세스 환경 주입 기능을 사용할 수 있다. `echo`, `printenv`, 셸 추적(`set -x`) 등으로 키를 출력하지 않는다. Jev가 켜진 `shadow`도 실제 TypeSafe 호출을 수행하므로 유료 실행 범위 확인에 포함한다.

Claude의 `UserPromptSubmit` 관찰 훅에서는 같은 Keychain 옵션을 사용할 수 있다. 관찰 훅 프로세스가 키체인에서 값을 직접 읽으므로 Claude 메인 프로세스에 `TYPESAFE_API_KEY`를 설정하지 않아도 된다. 함수 훅 자동 전환 플러그인은 macOS Keychain 명령에 의존하지 않고 `.env`를 읽는다. 짧은 후속 입력처럼 Jev 분류를 건너뛰는 경우에는 키 파일도 읽지 않는다.
