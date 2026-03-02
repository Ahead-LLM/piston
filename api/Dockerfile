FROM buildpack-deps:buster AS isolate
RUN printf 'Acquire::Check-Valid-Until "false";\nAcquire::AllowInsecureRepositories "true";\n' > /etc/apt/apt.conf.d/99archive && \
    sed -i 's|http://deb.debian.org/debian|http://archive.debian.org/debian|g; s|http://security.debian.org/debian-security|http://archive.debian.org/debian-security|g' /etc/apt/sources.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends git libcap-dev && \
    rm -rf /var/lib/apt/lists/* && \
    git clone https://github.com/envicutor/isolate.git /tmp/isolate/ && \
    cd /tmp/isolate && \
    git checkout af6db68042c3aa0ded80787fbb78bc0846ea2114 && \
    make -j$(nproc) install && \
    rm -rf /tmp/*

FROM node:15.10.0-buster-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV PISTON_AUTO_INSTALL_RUNTIMES=true
ENV PISTON_AUTO_INSTALL_FAIL_ON_ERROR=true
ENV PISTON_AUTO_INSTALL_PACKAGES="csharp=6.12.0,python=3.10.0,java=15.0.2,javascript=18.15.0,c++=10.2.0,sqlite3=3.36.0,c=10.2.0,ruby=3.0.1,go=1.16.2,rust=1.68.2,bash=5.2.0"

RUN dpkg-reconfigure -p critical dash
RUN printf 'Acquire::Check-Valid-Until "false";\nAcquire::AllowInsecureRepositories "true";\n' > /etc/apt/apt.conf.d/99archive && \
    sed -i 's|http://deb.debian.org/debian|http://archive.debian.org/debian|g; s|http://security.debian.org/debian-security|http://archive.debian.org/debian-security|g' /etc/apt/sources.list && \
    apt-get update && \
    apt-get install -y libxml2 gnupg tar coreutils util-linux libc6-dev \
    binutils build-essential locales libpcre3-dev libevent-dev libgmp3-dev \
    libncurses6 libncurses5 libedit-dev libseccomp-dev rename procps python3 \
    libreadline-dev libblas-dev liblapack-dev libpcre3-dev libarpack2-dev \
    libfftw3-dev libglpk-dev libqhull-dev libqrupdate-dev libsuitesparse-dev \
    libsundials-dev libpcre2-dev libcap-dev && \
    rm -rf /var/lib/apt/lists/*
RUN useradd -M piston
COPY --from=isolate /usr/local/bin/isolate /usr/local/bin
COPY --from=isolate /usr/local/etc/isolate /usr/local/etc/isolate

RUN sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen

WORKDIR /piston_api
COPY ["package.json", "package-lock.json", "./"]
RUN npm install
COPY ./src ./src
RUN mkdir -p /piston/packages
RUN node /piston_api/src/auto-install-runtimes.js

CMD ["/piston_api/src/docker-entrypoint.sh"]
EXPOSE 2000/tcp
